import type { GatewayFacts, ProtocolError, ProtocolStreamError, ProviderEvent, ProviderOperation, ProviderResult } from './pipeline-facts.ts';
import { getHeader, type HttpBodyError, type HttpResponseFact, type HttpStreamError } from '@floway-dev/http';
import { factSpace, type Facts, type ManagedStream, type Result } from '@floway-dev/pipeline';
import { isEventStreamMediaType, parseJSONWithRawNumbers } from '@floway-dev/protocols/common';

export type FormatProtocolError<Body = unknown> = (status: number | null, message: string) => Body;

type HttpByteStream = ManagedStream<Uint8Array, HttpBodyError>;
type ByteResults = AsyncIterable<Result<Uint8Array, HttpBodyError>>;
type StreamItems<Event> = AsyncGenerator<Result<Event, ProtocolStreamError>, void, unknown>;
type UpstreamHttpResponse = Omit<HttpResponseFact, 'body'> & { body: HttpByteStream | null };

export type ProtocolStreamDecoder<Event> = (source: ByteResults) => StreamItems<Event>;

interface BodyReader {
  read(source: HttpByteStream): AsyncIterableIterator<Result<Uint8Array, HttpBodyError>>;
  discard(source: HttpByteStream): void;
}

interface BodyProducer extends BodyReader {
  wrapStream<T, E, U, F>(inner: ManagedStream<T, E>, factory: (inner: ManagedStream<T, E>, scope: BodyReader) => AsyncGenerator<Result<U, F>, void, unknown>): ManagedStream<U, F>;
}

const { defineStage } = factSpace<Facts>();

const messageOf = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);

const ioError = <Body>(error: HttpBodyError, status: number | null, format: FormatProtocolError<Body>): ProtocolError<Body> =>
  error.kind === 'abort'
    ? { kind: 'error', source: 'local', error: format(status, 'Upstream request cancelled') }
    : { kind: 'error', source: 'upstream', error: format(status, messageOf(error.cause)) };

export const httpDialError = <Body>(error: HttpStreamError, format: FormatProtocolError<Body>): ProtocolError<Body> =>
  ioError(error, null, format);

const parseJson = (text: string): Result<unknown, SyntaxError> => {
  try {
    return { ok: true, value: parseJSONWithRawNumbers(text) };
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { ok: false, error };
  }
};

export const parseJsonBody = (bytes: Uint8Array): Result<unknown, SyntaxError> => parseJson(new TextDecoder().decode(bytes));

const readBody = async (body: HttpByteStream | null, scope: BodyReader): Promise<Result<Uint8Array, HttpBodyError>> => {
  if (body === null) return { ok: true, value: new Uint8Array() };

  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const item of scope.read(body)) {
    if (!item.ok) {
      scope.discard(body);
      return item;
    }
    chunks.push(item.value);
    length += item.value.byteLength;
  }
  if (chunks.length === 1) return { ok: true, value: chunks[0]! };
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, value: bytes };
};

const isSuccessful = ({ status }: HttpResponseFact): boolean => status >= 200 && status < 300;

const parseErrorBody = async (http: UpstreamHttpResponse, scope: BodyReader, format: FormatProtocolError): Promise<ProtocolError> => {
  const body = await readBody(http.body, scope);
  if (!body.ok) return ioError(body.error, http.status, format);
  const text = new TextDecoder().decode(body.value);
  const parsed = parseJson(text);
  return { kind: 'error', source: 'upstream', error: parsed.ok ? parsed.value : format(http.status, text) };
};

const BODY_SNIPPET_CHARS = 1024;

const readBodySnippet = async (body: HttpByteStream | null, scope: BodyReader): Promise<Result<string, HttpBodyError>> => {
  if (body === null) return { ok: true, value: '<empty>' };
  const decoder = new TextDecoder();
  let text = '';
  for await (const item of scope.read(body)) {
    if (!item.ok) {
      scope.discard(body);
      return item;
    }
    const remaining = BODY_SNIPPET_CHARS + 1 - text.length;
    text += decoder.decode(item.value.subarray(0, remaining * 4), { stream: true }).slice(0, remaining);
    if (text.length > BODY_SNIPPET_CHARS) {
      scope.discard(body);
      break;
    }
  }
  text += decoder.decode();
  if (text.length === 0) return { ok: true, value: '<empty>' };
  return { ok: true, value: text.length > BODY_SNIPPET_CHARS ? `${text.slice(0, BODY_SNIPPET_CHARS)}...[truncated]` : text };
};

const parseStream = async function* <Event>(
  source: HttpByteStream,
  producer: BodyReader,
  decode: ProtocolStreamDecoder<Event>,
): StreamItems<Event> {
  const cursor = producer.read(source);
  let held = true;
  const bytes: ByteResults = {
    [Symbol.asyncIterator]: () => ({
      async next() {
        const item = await cursor.next();
        if (item.done) held = false;
        return item;
      },
    }),
  };

  for await (const item of decode(bytes)) {
    if (!item.ok && held) {
      producer.discard(source);
      held = false;
    }
    yield item;
  }
  if (held) throw new Error('The protocol decoder returned before reading the HTTP body to native done');
};

type StreamOperation = { [Op in ProviderOperation]: [ProviderEvent<Op>] extends [never] ? never : Op }[ProviderOperation];
type ResultOperation = { [Op in ProviderOperation]: [ProviderResult<Op>] extends [never] ? never : Op }[ProviderOperation];
type MixedOperation = StreamOperation & ResultOperation;
type SingleOperation<Op, All = Op> = Op extends Op ? [All] extends [Op] ? Op : never : never;

type HttpAnswer = Pick<GatewayFacts, 'response.http'>;
type ParsedOutcome<Op extends ProviderOperation> = ProtocolError
  | { kind: 'stream'; stream: ManagedStream<ProviderEvent<Op>, ProtocolStreamError> }
  | { kind: 'result'; result: ProviderResult<Op> };

const isProtocolError = (value: unknown): value is ProtocolError => typeof value === 'object' && value !== null
  && 'kind' in value && value.kind === 'error'
  && 'source' in value && (value.source === 'upstream' || value.source === 'local') && 'error' in value;

const requireDialError = (value: unknown): ProtocolError => {
  if (!isProtocolError(value)) throw new Error('The provider dial stage must write a protocol error when response.http is null');
  return value;
};

type ResultDecoder<Op extends ProviderOperation> = (body: Uint8Array, http: HttpResponseFact) => Result<ProviderResult<Op>, unknown>;
type ParseMode<Op extends ProviderOperation> =
  | { kind: 'stream'; decode: ProtocolStreamDecoder<ProviderEvent<Op>> }
  | { kind: 'result'; decode: ResultDecoder<Op> };

const parseSuccess = async <Op extends ProviderOperation>(
  http: UpstreamHttpResponse,
  scope: BodyProducer,
  mode: ParseMode<Op>,
  format: FormatProtocolError,
): Promise<ParsedOutcome<Op>> => {
  if (mode.kind === 'result') {
    const body = await readBody(http.body, scope);
    if (!body.ok) return ioError(body.error, http.status, format);
    const result = mode.decode(body.value, http);
    return result.ok
      ? { kind: 'result', result: result.value }
      : { kind: 'error', source: 'upstream', error: format(http.status, messageOf(result.error)) };
  }

  const { body } = http;
  const mediaType = getHeader(http.headers, 'content-type');
  if (body === null || typeof mediaType !== 'string' || !isEventStreamMediaType(mediaType)) {
    const snippet = await readBodySnippet(body, scope);
    if (!snippet.ok) return ioError(snippet.error, http.status, format);
    const contentType = typeof mediaType === 'string' ? mediaType : 'unknown';
    const message = `Upstream returned ${http.status} with content-type "${contentType}" but stream is required. Body: ${snippet.value}`;
    return { kind: 'error', source: 'upstream', error: format(502, message) };
  }
  const stream = scope.wrapStream(body, (source, producer) => parseStream(source, producer, mode.decode));
  return { kind: 'stream', stream };
};

interface HttpResponseParsers<Op extends ProviderOperation> {
  select(request: GatewayFacts[`request.${Op}`], head: Omit<HttpResponseFact, 'body'>): 'stream' | 'result';
  stream: ProtocolStreamDecoder<ProviderEvent<Op>>;
  result: ResultDecoder<Op>;
  format: FormatProtocolError;
}

type ResponseParser<Op extends ProviderOperation> = { operation: Op; format: FormatProtocolError } & (
  ParseMode<Op> | (HttpResponseParsers<Op> & { kind: 'select' })
);

const responseParser = <Op extends ProviderOperation>(parser: ResponseParser<Op>) => {
  const { operation } = parser;
  const payload = `request.${operation}` as const;
  const outcome = `response.${operation}` as const;
  const requestNeeds: readonly string[] = parser.kind === 'select' ? [payload] : [];
  const responseNeeds: readonly string[] = ['response.http', `${outcome}?`];
  const responseProvides: readonly string[] = ['response.http', outcome];
  const through = {
    request: { needs: requestNeeds, provides: [], consumes: [] },
    response: { needs: responseNeeds, provides: responseProvides, consumes: [] },
  } as const;
  const answer = (http: HttpAnswer, parsed: ParsedOutcome<Op>) => ({ ...http, [outcome]: parsed });

  return defineStage({
    name: `${operation}.parse-response`,
    through,
    async execute(facts, scope) {
      const back = await scope.next(facts);
      const http = back['response.http'] as GatewayFacts['response.http'];
      if (http === null) return answer({ ...back, 'response.http': http }, requireDialError(back[outcome]));

      const { body, ...head } = http;
      if (body instanceof Uint8Array) throw new Error('The provider response parser requires an unopened HTTP body stream');
      const upstream = { ...head, body };
      const response = { ...back, 'response.http': { ...head, body: null } };
      if (!isSuccessful(http)) return answer(response, await parseErrorBody(upstream, scope, parser.format));

      let mode: ParseMode<Op>;
      if (parser.kind === 'select') {
        const request = facts[payload] as GatewayFacts[typeof payload];
        mode = parser.select(request, head) === 'stream'
          ? { kind: 'stream', decode: parser.stream }
          : { kind: 'result', decode: parser.result };
      } else {
        mode = parser;
      }
      return answer(response, await parseSuccess(upstream, scope, mode, parser.format));
    },
  });
};

export const parseSseResponse = <Op extends StreamOperation>(
  operation: Op & SingleOperation<Op>,
  decode: ProtocolStreamDecoder<ProviderEvent<NoInfer<Op>>>,
  format: FormatProtocolError,
) => responseParser<Op>({ operation, kind: 'stream', decode, format });

export const parseResultResponse = <Op extends ResultOperation>(
  operation: Op & SingleOperation<Op>,
  decode: ResultDecoder<NoInfer<Op>>,
  format: FormatProtocolError,
) => responseParser<Op>({ operation, kind: 'result', decode, format });

export const parseHttpResponse = <Op extends MixedOperation>(
  operation: Op & SingleOperation<Op>,
  parsers: HttpResponseParsers<NoInfer<Op>>,
) => responseParser<Op>({ ...parsers, operation, kind: 'select' });
