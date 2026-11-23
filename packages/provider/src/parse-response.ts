import { getHeader } from './headers.ts';
import type { HttpOutcome, ProtocolOutcome, ProviderFrame, ProviderResponsesInput, ProviderServices, ProviderUpstreamBase } from './pipelines.ts';
import { checkedHttpBodyChunks, openByteStream, readHttpBody, type HttpOutput } from './response-body.ts';
import { isTransportFailure, type HttpResponseBodyChunk, type HttpResponseFacts, type TransportFailure } from '@floway-dev/http';
import { Bytes, defineStage, snapshotError, type ErrorSnapshot, type FactValue, type Scope } from '@floway-dev/pipeline';
import { isEventStreamMediaType, UpstreamStreamProtocolError, type ProtocolFrame } from '@floway-dev/protocols/common';
import { parseOpenAIResponsesStream, type OpenAIResponsesCompactionResultEx, type OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

export type ProviderStreamParser<Event> = (
  body: ReadableStream<Uint8Array>,
  options?: { signal?: AbortSignal },
) => AsyncIterable<ProtocolFrame<Event>>;

export type FormatNonJsonError = (status: number, text: string) => FactValue;
export type FormatNonStreamError = (status: number, contentType: string | undefined, snippet: string) => FactValue;

interface ParseErrorOptions {
  readonly formatNonJsonError?: FormatNonJsonError;
}

interface ParseStreamOptions extends ParseErrorOptions {
  readonly formatNonStreamError?: FormatNonStreamError;
}

type UpstreamErrorOutcome = Extract<HttpOutcome, { kind: 'error' }> & { readonly source: 'upstream' };
type Parsed<Outcome> = HttpOutput & { readonly outcome: Outcome };
type OutcomeOutput<Key extends string, Outcome> = HttpOutput & Readonly<Record<Key, Outcome>>;

const withOutcome = <Key extends string, Outcome>(
  back: HttpOutput, key: Key, parsed: Parsed<Outcome>,
): OutcomeOutput<Key, Outcome> =>
  ({ ...back, 'response.http': parsed['response.http'], [key]: parsed.outcome } as OutcomeOutput<Key, Outcome>);

const successful = ({ status }: HttpResponseFacts): boolean => status >= 200 && status < 300;

const upstreamError = (type: string, message: string): FactValue => ({ error: { type, message } });

const parsedError = (http: HttpResponseFacts, error: FactValue): Parsed<UpstreamErrorOutcome> => ({
  'response.http': http,
  outcome: { kind: 'error', source: 'upstream', error },
});

const transportError = (http: HttpResponseFacts, error: ErrorSnapshot): Parsed<UpstreamErrorOutcome> =>
  parsedError(http, upstreamError('upstream_transport_error', error.message));

const readResponseText = async (http: HttpResponseFacts, { signal }: Pick<Scope, 'signal'>): Promise<
  { readonly text: string } | { readonly failure: Parsed<UpstreamErrorOutcome> }
> => {
  const body = await readHttpBody(http.body);
  signal.throwIfAborted();
  if (body.ok) return { text: body.bytes.utf8() };
  return { failure: transportError({ ...http, status: 502, statusText: '', body: null, transportError: body.error }, body.error) };
};

const defaultNonJsonError: FormatNonJsonError = (status, text) =>
  upstreamError('upstream_error', text || `Upstream returned HTTP ${status}`);

export const parseErrorBody = async (
  http: HttpResponseFacts,
  scope: Pick<Scope, 'signal'>,
  formatNonJsonError: FormatNonJsonError = defaultNonJsonError,
  preserveBody = false,
): Promise<Parsed<UpstreamErrorOutcome> | undefined> => {
  if (http.transportError !== undefined) return transportError(http, http.transportError);
  if (successful(http)) return undefined;
  const raw = await readHttpBody(http.body);
  scope.signal.throwIfAborted();
  if (!raw.ok) return transportError({ ...http, status: 502, statusText: '', body: null, transportError: raw.error }, raw.error);
  const text = raw.bytes.utf8();

  let error: FactValue;
  try {
    error = JSON.parse(text) as FactValue;
  } catch (cause) {
    if (!(cause instanceof SyntaxError)) throw cause;
    error = formatNonJsonError(http.status, text);
  }
  return parsedError({ ...http, body: preserveBody && http.body !== null ? raw.bytes : null }, error);
};

const bodySnippetChars = 1024;
const formatSnippet = (text: string): string => {
  if (text.length === 0) return '<empty>';
  return text.length > bodySnippetChars ? `${text.slice(0, bodySnippetChars)}...[truncated]` : text;
};

const bodySnippet = async (body: HttpResponseFacts['body']): Promise<string> => {
  if (body === null) return '<empty>';
  if (body instanceof Bytes) return formatSnippet(body.utf8());
  const decoder = new TextDecoder();
  let text = '';
  for await (const part of checkedHttpBodyChunks(body)) {
    if (isTransportFailure(part)) return '<unreadable>';
    text += decoder.decode(part.toUint8Array(), { stream: true });
    if (text.length > bodySnippetChars) return formatSnippet(text);
  }
  return formatSnippet(text + decoder.decode());
};

const defaultNonStreamError: FormatNonStreamError = (status, contentType, snippet) =>
  upstreamError('upstream_invalid_stream', `Upstream returned HTTP ${status} with content-type "${contentType ?? 'unknown'}" but a text/event-stream body is required. Body: ${snippet}`);

const parseSseChunks = async function* <Event>(
  source: AsyncIterable<HttpResponseBodyChunk>,
  parser: ProviderStreamParser<Event>,
  signal: AbortSignal,
): AsyncGenerator<ProviderFrame<Event>> {
  let interruption: { readonly failure: TransportFailure; readonly error: Error } | undefined;
  const bytes = async function* (): AsyncGenerator<Bytes> {
    for await (const chunk of checkedHttpBodyChunks(source)) {
      if (isTransportFailure(chunk)) {
        // A clean EOF would let the parser flush an incomplete SSE frame.
        interruption = { failure: chunk, error: new Error(chunk.error.message) };
        throw interruption.error;
      }
      yield chunk;
    }
  };
  const { stream, close } = openByteStream(bytes());
  try {
    yield* parser(stream, { signal });
  } catch (error) {
    if (interruption !== undefined && error === interruption.error) {
      // Fall through to emit the upstream transport failure once below.
    } else if (!signal.aborted && error instanceof UpstreamStreamProtocolError) {
      interruption = { failure: { type: 'transport-error', error: snapshotError(error) }, error };
    } else {
      throw error;
    }
  } finally {
    await close();
  }
  if (interruption !== undefined && !signal.aborted) yield interruption.failure;
};

export const parseSseBody = async <Event, S>(
  http: HttpResponseFacts,
  scope: Scope<S>,
  parser: ProviderStreamParser<Event>,
  formatNonStreamError: FormatNonStreamError = defaultNonStreamError,
): Promise<Parsed<ProtocolOutcome<Event>>> => {
  const contentType = getHeader(http.headers, 'content-type');
  const { body } = http;
  const response = { ...http, body: null };
  if (body === null || !isEventStreamMediaType(contentType)) {
    const snippet = await bodySnippet(body);
    scope.signal.throwIfAborted();
    return parsedError({ ...response, status: 502, statusText: '' }, formatNonStreamError(http.status, contentType, snippet));
  }

  const parse = (source: AsyncIterable<HttpResponseBodyChunk>, { signal }: Scope<S>) => parseSseChunks(source, parser, signal);
  const events = body instanceof Bytes
    ? scope.createStream({ label: 'http.events', iterate: streamScope => parse((async function* () { yield body; })(), streamScope) })
    : scope.wrapStream(body, { label: 'http.events', transform: parse });
  return { 'response.http': response, outcome: { kind: 'stream', events } };
};

export const parseSseStage = <Key extends string, Event, Input = {}, S extends ProviderServices = ProviderServices>(
  name: string,
  responseKey: Key,
  parser: ProviderStreamParser<Event>,
  options?: ParseStreamOptions & { readonly needs?: readonly (keyof Input & string)[] },
) => defineStage<Input, Input, HttpOutput, OutcomeOutput<Key, ProtocolOutcome<Event>>, S>({
  name,
  through: {
    request: { needs: options?.needs ?? [], consumes: [], provides: [] },
    response: { needs: ['response.http'], consumes: [], provides: ['response.http', responseKey] },
  },
  async execute(facts, scope) {
    const back = await scope.next(facts);
    const http = back['response.http'];
    const failure = await parseErrorBody(http, scope, options?.formatNonJsonError);
    return withOutcome(back, responseKey, failure ?? await parseSseBody(http, scope, parser, options?.formatNonStreamError));
  },
});

const parseCompactionBody = async (
  http: HttpResponseFacts,
  scope: Pick<Scope, 'signal'>,
): Promise<Parsed<ProtocolOutcome<never, OpenAIResponsesCompactionResultEx>>> => {
  const body = await readResponseText(http, scope);
  if ('failure' in body) return body.failure;

  const response = { ...http, body: null };
  let result: OpenAIResponsesCompactionResultEx;
  try {
    result = JSON.parse(body.text) as OpenAIResponsesCompactionResultEx;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return parsedError({ ...response, status: 502, statusText: '' }, upstreamError('upstream_invalid_json', `Upstream returned invalid Responses compaction JSON. Body: ${formatSnippet(body.text)}`));
  }
  return { 'response.http': response, outcome: { kind: 'result', result } };
};

type ResponsesOutcome = ProtocolOutcome<OpenAIResponsesStreamEventEx, OpenAIResponsesCompactionResultEx>;
type ResponsesOutput = OutcomeOutput<'response.openaiResponses', ResponsesOutcome>;

export const parseResponsesStage = <
  Upstream extends ProviderUpstreamBase = ProviderUpstreamBase,
  S extends ProviderServices = ProviderServices,
>(name = 'parseResponses', options?: ParseStreamOptions) =>
  defineStage<ProviderResponsesInput<Upstream>, ProviderResponsesInput<Upstream>, HttpOutput, ResponsesOutput, S>({
    name,
    through: {
      request: { needs: ['request.action'], consumes: [], provides: [] },
      response: { needs: ['response.http'], consumes: [], provides: ['response.http', 'response.openaiResponses'] },
    },
    async execute(facts, scope) {
      const back = await scope.next(facts);
      const http = back['response.http'];
      const failure = await parseErrorBody(http, scope, options?.formatNonJsonError);
      const parsed = failure ?? (
        facts['request.action'] === 'compact'
          ? await parseCompactionBody(http, scope)
          : await parseSseBody(http, scope, parseOpenAIResponsesStream, options?.formatNonStreamError)
      );
      return withOutcome<'response.openaiResponses', ResponsesOutcome>(back, 'response.openaiResponses', parsed);
    },
  });

interface ParseHttpOptions<Extra extends object, Input> extends ParseErrorOptions {
  readonly needs?: readonly (keyof Input & string)[];
  readonly extra?: (facts: Input) => Extra;
}

export function parseHttpOutcomeStage<Key extends string, Extra extends object, Input = {}, S extends ProviderServices = ProviderServices>(
  name: string, responseKey: Key, options: ParseHttpOptions<Extra, Input> & { readonly extra: (facts: Input) => Extra },
): ReturnType<typeof makeHttpOutcomeStage<Key, Extra, Input, S>>;
export function parseHttpOutcomeStage<Key extends string, Input = {}, S extends ProviderServices = ProviderServices>(
  name: string, responseKey: Key, options?: ParseHttpOptions<{}, Input>,
): ReturnType<typeof makeHttpOutcomeStage<Key, {}, Input, S>>;
export function parseHttpOutcomeStage<Key extends string, Extra extends object, Input, S extends ProviderServices>(
  name: string, responseKey: Key, options?: ParseHttpOptions<Extra, Input>,
) {
  return makeHttpOutcomeStage<Key, Extra, Input, S>(name, responseKey, options);
}

function makeHttpOutcomeStage<Key extends string, Extra extends object, Input, S extends ProviderServices>(
  name: string, responseKey: Key, options?: ParseHttpOptions<Extra, Input>,
) {
  return defineStage<Input, Input, HttpOutput, OutcomeOutput<Key, HttpOutcome<Extra>>, S>({
    name,
    through: {
      request: { needs: options?.needs ?? [], consumes: [], provides: [] },
      response: { needs: ['response.http'], consumes: [], provides: ['response.http', responseKey] },
    },
    async execute(facts, scope) {
      const back = await scope.next(facts);
      const http = back['response.http'];
      const failure = await parseErrorBody(http, scope, options?.formatNonJsonError, true);
      return withOutcome(back, responseKey, failure ?? {
        'response.http': http,
        outcome: { ...options?.extra?.(facts), kind: 'ok' } as HttpOutcome<Extra>,
      });
    },
  });
}
