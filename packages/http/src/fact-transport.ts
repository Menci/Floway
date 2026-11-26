import { bindHttpAbort, isCausedBy } from './abort.ts';
import { HttpResponseError, HttpTransportError } from './errors.ts';
import type { HttpRequestFact, HttpResponseFact, HttpStreamError } from './facts.ts';
import { responseHeaderEntries } from './headers.ts';
import type { Fetcher, FetchResponse } from './types.ts';
import type { Result } from '@floway-dev/pipeline';
import { revealSecret } from '@floway-dev/pipeline/transport';

export type SerializedHttpRequest = Omit<HttpRequestFact, 'body'> & { body: string | Uint8Array | null };

type HttpByteStream = AsyncGenerator<Result<Uint8Array, HttpStreamError>, void, unknown>;

export type HttpResponseSource = Omit<HttpResponseFact, 'body'> & { body: HttpByteStream | null };

const httpFailure = (
  cause: unknown,
  signal: AbortSignal,
  classifyBodyFailure?: FetchResponse['classifyBodyFailure'],
): HttpStreamError => {
  if (isCausedBy(cause, signal.reason)) return { kind: 'abort', cause };
  if (cause instanceof HttpTransportError || cause instanceof HttpResponseError) {
    return { kind: 'transport', cause };
  }
  const classified = classifyBodyFailure?.(cause);
  if (classified !== undefined) return classified;
  throw cause;
};

const readBody = (
  body: ReadableStream<Uint8Array>,
  classifyBodyFailure: FetchResponse['classifyBodyFailure'],
  { signal, release }: ReturnType<typeof bindHttpAbort>,
): HttpByteStream => {
  let started = false;
  const stream = (async function* (): HttpByteStream {
    started = true;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let terminal = false;
    let failure: HttpStreamError;
    try {
      reader = body.getReader();
      while (true) {
        let item: ReadableStreamReadResult<Uint8Array>;
        try {
          item = await reader.read();
        } catch (cause) {
          terminal = true;
          failure = httpFailure(cause, signal, classifyBodyFailure);
          break;
        }
        if (item.done) {
          terminal = true;
          return;
        }
        yield { ok: true, value: item.value };
      }
    } finally {
      release();
      try {
        if (reader !== undefined && !terminal) await reader.cancel();
      } finally {
        reader?.releaseLock();
      }
    }
    yield { ok: false, error: failure };
  })();

  // Native generator return skips its finally block before the first next.
  // The HTTP source already owns the response stream at that point.
  const end = stream.return.bind(stream);
  stream.return = value => {
    if (started) return end(value);
    started = true;
    release();
    const closed = end(value);
    return body.cancel().then(() => closed);
  };
  return stream;
};

export const sendHttpRequest = async (
  fetcher: Fetcher,
  request: SerializedHttpRequest,
  signal: AbortSignal,
): Promise<Result<HttpResponseSource, HttpStreamError>> => {
  if (signal.aborted) return { ok: false, error: { kind: 'abort', cause: signal.reason } };
  const { url, method, body } = request;
  const headers: [string, string][] = request.headers.map(([name, value]) => [name, typeof value === 'string' ? value : revealSecret(value)]);
  const wireBody = body instanceof Uint8Array
    ? body.buffer instanceof ArrayBuffer ? body as Uint8Array<ArrayBuffer> : new Uint8Array(body)
    : body;
  const binding = bindHttpAbort(signal);
  let transferred = false;
  try {
    let response: FetchResponse;
    try {
      response = await fetcher(url, { method, headers, body: wireBody, signal: binding.signal });
    } catch (cause) {
      return { ok: false, error: httpFailure(cause, binding.signal) };
    }
    const { status, statusText, body: readable, classifyBodyFailure } = response;
    const responseHeaders = responseHeaderEntries(response);
    const source = readable === null ? null : readBody(readable, classifyBodyFailure, binding);
    transferred = source !== null;
    return { ok: true, value: { status, statusText, headers: responseHeaders, body: source } };
  } finally {
    if (!transferred) binding.release();
  }
};
