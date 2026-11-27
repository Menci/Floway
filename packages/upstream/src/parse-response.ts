import { toInternalDebugError, type InternalDebugError } from './error.ts';
import type { ProtocolError, ProtocolResult, ProtocolStream, ProtocolStreamError } from './pipeline-facts.ts';
import { getHeader, type HttpResponseFact, type HttpStreamError } from '@floway-dev/http';
import type { ManagedStream, Result } from '@floway-dev/pipeline';
import { isEventStreamMediaType, parseJSONWithRawNumbers } from '@floway-dev/protocols/common';

export type FormatProtocolError<Body = unknown> = (status: number | null, message: string, diagnostic?: InternalDebugError) => Body;

type HttpByteStream = ManagedStream<Uint8Array, HttpStreamError>;
type ByteResults = AsyncIterable<Result<Uint8Array, HttpStreamError>>;
type StreamItems<Event> = AsyncGenerator<Result<Event, ProtocolStreamError>, void, unknown>;

export type ProtocolStreamDecoder<Event> = (source: ByteResults) => StreamItems<Event>;

type HttpHead = Omit<HttpResponseFact, 'body'>;
type HttpWithoutBody = HttpHead & { body: null };

interface BodyReader {
  read(source: HttpByteStream): AsyncIterableIterator<Result<Uint8Array, HttpStreamError>>;
  discard(source: HttpByteStream): void;
}

interface BodyProducer extends BodyReader {
  wrapStream<Event>(inner: HttpByteStream, factory: (inner: HttpByteStream, scope: BodyReader) => StreamItems<Event>): ManagedStream<Event, ProtocolStreamError>;
}

interface ParsedResponse<Outcome> {
  http: HttpWithoutBody;
  outcome: Outcome | ProtocolError;
}

const messageOf = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);

const ioError = <Body>(error: HttpStreamError, status: number | null, format: FormatProtocolError<Body>): ProtocolError<Body> => {
  if (error.kind === 'abort') return { kind: 'error', source: 'local', error: format(499, 'Upstream request cancelled') };
  const diagnostic = toInternalDebugError(error.cause);
  return { kind: 'error', source: 'upstream', error: format(status, diagnostic.message, diagnostic) };
};

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

const bodyLimitExceeded = (limit: number): RangeError => new RangeError(`Upstream response body exceeds ${limit} bytes`);

const readBody = async (body: HttpResponseFact['body'], scope: BodyReader, maxBodyBytes: number): Promise<Result<Uint8Array, HttpStreamError>> => {
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 0) {
    throw new RangeError(`Invalid upstream response body limit: ${maxBodyBytes}`);
  }
  if (body === null) return { ok: true, value: new Uint8Array() };
  if (body instanceof Uint8Array) {
    if (body.byteLength > maxBodyBytes) throw bodyLimitExceeded(maxBodyBytes);
    return { ok: true, value: body };
  }

  const chunks: Uint8Array[] = [];
  let length = 0;
  const cursor = scope.read(body);
  while (true) {
    const item = await cursor.next();
    if (item.done) break;
    const { value: chunk } = item;
    if (!chunk.ok) {
      scope.discard(body);
      return chunk;
    }
    const bytes = chunk.value.byteLength;
    if (bytes > maxBodyBytes - length) throw bodyLimitExceeded(maxBodyBytes);
    if (bytes === 0) continue;
    chunks.push(chunk.value);
    length += bytes;
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

const isSuccessful = ({ status }: HttpHead): boolean => status >= 200 && status < 300;

const parseErrorBody = async (http: HttpResponseFact, scope: BodyReader, format: FormatProtocolError, maxBodyBytes: number): Promise<ProtocolError> => {
  const body = await readBody(http.body, scope, maxBodyBytes);
  if (!body.ok) return ioError(body.error, http.status, format);
  const text = new TextDecoder().decode(body.value);
  const parsed = parseJson(text);
  return { kind: 'error', source: 'upstream', error: parsed.ok ? parsed.value : format(http.status, text) };
};

const BODY_SNIPPET_CHARS = 1024;

const readBodySnippet = async (body: HttpResponseFact['body'], scope: BodyReader): Promise<Result<string, HttpStreamError>> => {
  const decoder = new TextDecoder();
  let text = '';
  if (body instanceof Uint8Array) {
    text = decoder.decode(body.subarray(0, (BODY_SNIPPET_CHARS + 1) * 4));
  } else if (body !== null) {
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
  }
  if (text.length === 0) return { ok: true, value: '<empty>' };
  if (text.length > BODY_SNIPPET_CHARS) text = `${text.slice(0, BODY_SNIPPET_CHARS)}...[truncated]`;
  return { ok: true, value: text };
};

const parseStream = async function* <Event>(
  source: HttpByteStream,
  scope: BodyReader,
  decode: ProtocolStreamDecoder<Event>,
): StreamItems<Event> {
  const cursor = scope.read(source);
  let held = true;
  // The decoder can return after an Err. The wrapper holds custody and can
  // discard the body before closing; iterator return would enforce native done.
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
      scope.discard(source);
      held = false;
    }
    yield item;
  }
  if (held) throw new Error('The protocol decoder returned before reading the HTTP body to native done');
};

export const parseUpstreamResult = async <Output>(
  response: HttpResponseFact,
  scope: BodyReader,
  decode: (body: Uint8Array, head: HttpWithoutBody) => Result<Output, unknown>,
  format: FormatProtocolError,
  limits: { maxResultBodyBytes: number; maxErrorBodyBytes: number },
): Promise<ParsedResponse<ProtocolResult<Output>>> => {
  const http = { ...response, body: null };
  if (!isSuccessful(http)) return { http, outcome: await parseErrorBody(response, scope, format, limits.maxErrorBodyBytes) };
  const body = await readBody(response.body, scope, limits.maxResultBodyBytes);
  if (!body.ok) return { http, outcome: ioError(body.error, http.status, format) };
  const parsed = decode(body.value, http);
  return {
    http,
    outcome: parsed.ok
      ? { kind: 'result', result: parsed.value }
      : { kind: 'error', source: 'upstream', error: format(502, messageOf(parsed.error)) },
  };
};

export const parseUpstreamStream = async <Event>(
  response: HttpResponseFact,
  scope: BodyProducer,
  decode: ProtocolStreamDecoder<Event>,
  format: FormatProtocolError,
  maxErrorBodyBytes: number,
): Promise<ParsedResponse<ProtocolStream<Event>>> => {
  const http = { ...response, body: null };
  if (!isSuccessful(http)) return { http, outcome: await parseErrorBody(response, scope, format, maxErrorBodyBytes) };
  const { body } = response;
  const contentType = getHeader(http.headers, 'content-type');
  if (body === null || typeof contentType !== 'string' || !isEventStreamMediaType(contentType)) {
    const snippet = await readBodySnippet(body, scope);
    if (!snippet.ok) return { http, outcome: ioError(snippet.error, http.status, format) };
    const mediaType = typeof contentType === 'string' ? contentType : 'unknown';
    const message = `Upstream returned ${http.status} with content-type "${mediaType}" but a stream is required. Body: ${snippet.value}`;
    return { http, outcome: { kind: 'error', source: 'upstream', error: format(502, message) } };
  }
  if (body instanceof Uint8Array) throw new Error('A streaming upstream response requires an unopened HTTP body stream');
  const stream = scope.wrapStream(body, (inner, producer) => parseStream(inner, producer, decode));
  return { http, outcome: { kind: 'stream', stream } };
};
