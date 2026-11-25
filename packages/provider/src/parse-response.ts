import type { ProviderTransportFacts } from './http-terminal.ts';
import type { ProtocolError, ProtocolStreamError } from './pipelines.ts';
import { getHeader, isHttpBodyStream, readHttpBody, type HttpResponseFact, type HttpStreamError } from '@floway-dev/http';
import type { ManagedStream, Result } from '@floway-dev/pipeline';
import { isEventStreamMediaType, parseJSONWithRawNumbers, type ParsedProtocolFrame } from '@floway-dev/protocols/common';

export type FormatProviderError<Body> = (status: number | null, message: string) => Body;

export type ProviderStreamParser<Event> = (
  body: ReadableStream<Uint8Array>,
  options?: { signal?: AbortSignal | undefined },
) => AsyncIterable<ParsedProtocolFrame<Event>>;

export type ProviderSseEof<Event> =
  | { readonly kind: 'complete' }
  | { readonly kind: 'doneFrame' }
  | { readonly kind: 'terminalEvent'; readonly isTerminal: (event: Event) => boolean };

interface Parsed<Outcome> {
  readonly http: HttpResponseFact | null;
  readonly outcome: Outcome;
}

interface ProducerScope {
  readonly signal: AbortSignal;
  readonly abort: (key: object) => void;
}

interface StreamScope extends Pick<ProducerScope, 'abort'> {
  readonly createStream: <T, E>(iterate: (scope: ProducerScope) => AsyncIterable<Result<T, E>>) => ManagedStream<T, E>;
  readonly wrapStream: <T, E, U, F>(
    stream: ManagedStream<T, E>,
    iterate: (stream: AsyncIterable<Result<T, E>>, scope: ProducerScope) => AsyncIterable<Result<U, F>>,
  ) => ManagedStream<U, F>;
}

const successful = ({ status }: HttpResponseFact): boolean => status >= 200 && status < 300;

const upstreamError = <Body>(http: HttpResponseFact | null, error: Body): Parsed<ProtocolError<Body>> => ({
  http,
  outcome: { kind: 'error', source: 'upstream', error },
});

const upstreamFailure = <Body>(
  http: HttpResponseFact | null,
  message: string,
  cause: unknown,
  format: FormatProviderError<Body>,
): Parsed<ProtocolError<Body>> => ({
  http,
  outcome: { kind: 'error', source: 'upstream', error: format(http?.status ?? null, message), cause },
});

const errorMessage = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);

const transportFailure = <Body>(
  http: HttpResponseFact | null,
  failure: HttpStreamError,
  format: FormatProviderError<Body>,
): Parsed<ProtocolError<Body>> => upstreamFailure(http, errorMessage(failure.cause), failure, format);

const parseJson = (text: string): Result<unknown, SyntaxError> => {
  try {
    return { ok: true, value: parseJSONWithRawNumbers(text) };
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { ok: false, error };
  }
};

export const parseJsonBody = (bytes: Uint8Array): Result<unknown, SyntaxError> => parseJson(new TextDecoder().decode(bytes));

export const parseErrorBody = async <Body>(http: HttpResponseFact, format: FormatProviderError<Body>) => {
  const body = await readHttpBody(http.body);
  const response = { ...http, body: null };
  if (!body.ok) return transportFailure(response, body.error, format);

  const text = new TextDecoder().decode(body.value);
  const parsed = parseJson(text);
  // A synthesized envelope keeps the parse failure as its cause, so a protocol whose
  // rendering differs for non-JSON upstream bodies can tell them from native JSON errors.
  return parsed.ok ? upstreamError(response, parsed.value) : upstreamFailure(response, text, parsed.error, format);
};

export const parseResultBody = async <Output, Body>(
  { 'response.transport': result }: ProviderTransportFacts,
  parse: (bytes: Uint8Array, http: HttpResponseFact) => Result<Output, unknown>,
  format: FormatProviderError<Body>,
) => {
  if (!result.ok) return transportFailure(null, result.error, format);
  const http = result.value;
  if (!successful(http)) return await parseErrorBody(http, format);

  const body = await readHttpBody(http.body);
  const response = { ...http, body: null };
  if (!body.ok) return transportFailure(response, body.error, format);

  const outcome = parse(body.value, http);
  if (!outcome.ok) return upstreamFailure(response, errorMessage(outcome.error), outcome.error, format);
  return { http: response, outcome: { kind: 'result', result: outcome.value } } as const;
};

const parseSse = async function* <Event>(
  source: AsyncIterable<Result<Uint8Array, HttpStreamError>>,
  { signal }: ProducerScope,
  parser: ProviderStreamParser<Event>,
  eof: ProviderSseEof<Event>,
  abort: () => void,
): AsyncGenerator<Result<Event, ProtocolStreamError>> {
  const cursor = source[Symbol.asyncIterator]();
  let pending: Promise<void> | undefined;
  let ended = false;
  let cancelled = false;
  let bodyFailure: HttpStreamError | undefined;
  let panic: { readonly cause: unknown } | undefined;

  // The parser can close its Web stream at a protocol terminator. The managed cursor still joins native done.
  const readable = new ReadableStream<Uint8Array>({
    pull(controller) {
      pending = (async () => {
        try {
          const item = await cursor.next();
          if (item.done) {
            ended = true;
            if (!cancelled) controller.close();
          } else if (!item.value.ok) {
            bodyFailure = item.value.error;
            if (!cancelled) controller.error(bodyFailure);
          } else if (!cancelled) controller.enqueue(item.value.value);
        } catch (cause) {
          panic = { cause };
          if (!cancelled) controller.error(cause);
        }
      })();
      return pending;
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });

  let completed = false;
  let sawTerminalEvent = false;
  let failure: ProtocolStreamError | undefined;
  try {
    for await (const frame of parser(readable, { signal })) {
      if (frame.type === 'done') {
        completed = true;
        break;
      }
      if (frame.type === 'error') {
        failure = { kind: 'protocol', cause: frame.cause };
        break;
      }
      if (eof.kind === 'terminalEvent' && eof.isTerminal(frame.event)) sawTerminalEvent = true;
      yield { ok: true, value: frame.event };
    }
  } catch (cause) {
    if (panic) throw panic.cause;
    if (bodyFailure && cause === bodyFailure) failure = bodyFailure;
    else throw cause;
  }

  if (failure || completed) abort();
  if (failure) yield { ok: false, error: failure };
  await pending;
  if (panic) throw panic.cause;
  if (bodyFailure && !failure) {
    failure = bodyFailure;
    yield { ok: false, error: failure };
  }

  while (!ended) {
    const item = await cursor.next();
    if (item.done) break;
    if (!item.value.ok && !failure && !(completed && !signal.aborted && item.value.error.kind === 'abort')) {
      failure = item.value.error;
      yield { ok: false, error: failure };
    }
  }
  if (!failure && !completed) {
    if (eof.kind === 'doneFrame') {
      yield { ok: false, error: { kind: 'protocol', cause: new Error('Upstream SSE ended without a [DONE] sentinel') } };
    } else if (eof.kind === 'terminalEvent' && !sawTerminalEvent) {
      yield { ok: false, error: { kind: 'protocol', cause: new Error('Upstream SSE ended before a terminal event') } };
    }
  }
};

export const parseSseBody = async <Event, Body>(
  back: ProviderTransportFacts,
  scope: StreamScope,
  parser: ProviderStreamParser<Event>,
  eof: ProviderSseEof<Event>,
  format: FormatProviderError<Body>,
) => {
  const result = back['response.transport'];
  if (!result.ok) return transportFailure(null, result.error, format);
  const http = result.value;
  if (!successful(http)) return await parseErrorBody(http, format);

  const { body } = http;
  const response = { ...http, body: null };
  const contentType = getHeader(http.headers, 'content-type');
  if (body === null || typeof contentType !== 'string' || !isEventStreamMediaType(contentType)) {
    if (isHttpBodyStream(body)) {
      scope.abort(back);
      for await (const _item of body) {
        // The rejected body still belongs to this stage until native done.
      }
    }
    return upstreamFailure(response, 'Expected an upstream text/event-stream response', {
      contentType: typeof contentType === 'string' ? contentType : null,
      hasBody: body !== null,
    }, format);
  }

  if (isHttpBodyStream(body)) {
    const stream = scope.wrapStream(body, (source, producer) => parseSse(source, producer, parser, eof, () => producer.abort(back)));
    return { http: response, outcome: { kind: 'stream', stream } } as const;
  }

  const raw = await readHttpBody(body);
  if (!raw.ok) return transportFailure(response, raw.error, format);
  const source = (async function* () { yield { ok: true, value: raw.value } as const; })();
  const stream = scope.createStream(producer => parseSse(source, producer, parser, eof, () => {}));
  return { http: response, outcome: { kind: 'stream', stream } } as const;
};
