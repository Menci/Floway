import { isCausedBy, signalAbortReason } from './abort.ts';
import { UnsupportedContentEncodingError } from './errors.ts';
import type { HttpBodyError, HttpRequestFact, HttpResponseFact, HttpStreamError } from './facts.ts';
import { responseHeaderEntries } from './headers.ts';
import type { ProviderFetcher, ProviderFetchResult } from './types.ts';
import { UpstreamTransportError } from './upstream-transport.ts';
import type { Result } from '@floway-dev/pipeline';
import { revealSecret } from '@floway-dev/pipeline/transport';

type HttpByteStream = AsyncGenerator<Result<Uint8Array, HttpBodyError>, void, unknown>;
type HttpResponseSource = Omit<HttpResponseFact, 'body'> & { body: HttpByteStream | null };

const bindAbort = (parent: AbortSignal) => {
  const controller = new AbortController();
  const onAbort = () => controller.abort(new Error('HTTP request cancelled', { cause: signalAbortReason(parent) }));
  let bound = true;
  parent.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    release: () => {
      if (!bound) return;
      bound = false;
      parent.removeEventListener('abort', onAbort);
    },
  };
};

const ioFailure = (cause: unknown, signal: AbortSignal): HttpStreamError | undefined => {
  if (isCausedBy(cause, signal.reason)) return { kind: 'abort', cause };
  if (cause instanceof UpstreamTransportError) return { kind: 'transport', cause };
};

const settleFetch = <T>(pending: Promise<T>, signal: AbortSignal): Promise<Result<T, HttpStreamError>> => pending.then(
  value => ({ ok: true, value }),
  (cause: unknown) => {
    const failure = ioFailure(cause, signal);
    if (failure !== undefined) return { ok: false, error: failure };
    throw cause;
  },
);

const settleRead = <T>(
  pending: Promise<T>,
  signal: AbortSignal,
  identify: ProviderFetchResult['identifyBodyTransportFailure'],
): Promise<Result<T, HttpBodyError>> => pending.then(
  value => ({ ok: true, value }),
  (cause: unknown) => {
    const failure = ioFailure(cause, signal);
    if (failure !== undefined) return { ok: false, error: failure };
    if (cause instanceof UnsupportedContentEncodingError) return { ok: false, error: { kind: 'protocol', cause } };
    const transport = identify?.(cause);
    if (transport !== undefined) return { ok: false, error: { kind: 'transport', cause: transport } };
    throw cause;
  },
);

const readHttpResponseBody = (
  body: ReadableStream<Uint8Array>,
  { signal, release }: ReturnType<typeof bindAbort>,
  identify: ProviderFetchResult['identifyBodyTransportFailure'],
): HttpByteStream => {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let closed = false;
  const finish = (): void => {
    if (closed) return;
    closed = true;
    reader?.releaseLock();
    release();
  };
  const items = (async function* (): HttpByteStream {
    let failure: HttpBodyError | undefined;
    try {
      reader = body.getReader();
      while (true) {
        // Check cancellation before starting the next read, while there is no pending I/O to classify.
        if (signal.aborted) {
          const cancellation = await settleRead(reader.cancel(signal.reason), signal, undefined);
          failure = cancellation.ok ? { kind: 'abort', cause: signal.reason } : cancellation.error;
          break;
        }
        const item = await settleRead(reader.read(), signal, identify);
        if (!item.ok) {
          failure = item.error;
          break;
        }
        if (item.value.done) return;
        yield { ok: true, value: item.value.value };
      }
    } finally {
      finish();
    }
    yield { ok: false, error: failure };
  })();
  const end = items.return.bind(items);
  let closing: ReturnType<HttpByteStream['return']> | undefined;
  items.return = value => closing ??= (async () => {
    if (!closed) {
      release();
      try { await (reader === undefined ? body.cancel() : reader.cancel()); } finally { finish(); }
    }
    return await end(value);
  })();
  return items;
};

export const sendHttpRequest = async (
  fetcher: ProviderFetcher,
  request: HttpRequestFact,
  signal: AbortSignal,
): Promise<Result<HttpResponseSource, HttpStreamError>> => {
  if (signal.aborted) return { ok: false, error: { kind: 'abort', cause: signalAbortReason(signal) } };
  const headers: [string, string][] = request.headers.map(([name, value]) => [name, typeof value === 'string' ? value : revealSecret(value)]);
  const body = request.body === null || request.body.buffer instanceof ArrayBuffer
    ? request.body as Uint8Array<ArrayBuffer> | null
    : new Uint8Array(request.body);
  const binding = bindAbort(signal);
  let readingBody = false;
  try {
    const { url, method } = request;
    const init = { method, headers, body, signal: binding.signal };
    const startedAt = performance.now();
    const result = await settleFetch(fetcher(url, init), binding.signal);
    if (!result.ok) return result;
    const { response, identifyBodyTransportFailure } = result.value;
    const { status, statusText, body: readable } = response;
    const responseHeaders = responseHeaderEntries(response);
    readingBody = readable !== null;
    return {
      ok: true,
      value: { status, statusText, headers: responseHeaders, body: readable === null ? null : readHttpResponseBody(readable, binding, identifyBodyTransportFailure), startedAt },
    };
  } finally {
    if (!readingBody) binding.release();
  }
};
