import type { ProviderServices } from './pipelines.ts';
import { openByteStream, type HttpOutput } from './response-body.ts';
import { wrapSensitiveHeaderEntries, type FetchInit, type HttpRequestFacts, type HttpUrl } from '@floway-dev/http';
import { Bytes, defineEnding, type ManagedStream, type StageEnv } from '@floway-dev/pipeline';
import { viewOf } from '@floway-dev/pipeline/bytes-view';

type HttpInput = { readonly 'request.http': HttpRequestFacts };

const materializeUrl = ({ origin, pathname, query }: HttpUrl): string => {
  if (!query?.length) return `${origin}${pathname}`;
  const search = query.map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(typeof value === 'string' ? value : value.reveal())}`);
  return `${origin}${pathname}?${search.join('&')}`;
};

const createResponseBody = (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  request: AbortController,
  env: StageEnv<ProviderServices>,
): ManagedStream<Bytes> => {
  let cancellation: Promise<void> | undefined;
  let exhausted = false;
  let readFailed = false;
  const read = async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
    try {
      return await reader.read();
    } catch (error) {
      readFailed = true;
      throw error;
    }
  };
  const cancel = (reason?: unknown): Promise<void> => {
    cancellation ??= reader.cancel(reason);
    return cancellation;
  };
  return env.createStream({
    label: 'http.body',
    async *iterate(signal) {
      // The kernel joins an outstanding pull before it runs onClose.
      const interrupt = (): void => {
        if (exhausted) return;
        // onClose awaits this same cancellation and reports a teardown failure.
        void cancel(signal.reason).catch(() => undefined);
        request.abort(signal.reason);
      };
      signal.addEventListener('abort', interrupt, { once: true });
      try {
        if (signal.aborted) interrupt();
        for (;;) {
          const next = await read();
          if (next.done) {
            exhausted = !signal.aborted;
            return;
          }
          yield Bytes.adopt(next.value);
        }
      } finally {
        signal.removeEventListener('abort', interrupt);
      }
    },
    async onClose(end) {
      try {
        if (!exhausted) {
          const reason = end.how === 'cancelled' ? end.reason : end.how === 'errored' ? end.error : undefined;
          const settled = readFailed ? cancellation : cancel(reason);
          request.abort(reason);
          await settled;
        }
      } finally {
        reader.releaseLock();
      }
    },
  });
};

export const httpTerminal = (upstreamId: string, name = 'http') => defineEnding<HttpInput, HttpOutput, {}, ProviderServices>({
  name,
  request: { needs: ['request.http'] },
  return: { provides: ['response.http'] },
  async execute({ 'request.http': request }, _into, env) {
    const fetcher = env.services.fetcher(upstreamId);
    const url = materializeUrl(request.url);
    const headers = request.headers.map(([key, value]): [string, string] => [key, typeof value === 'string' ? value : value.reveal()]);
    const controller = new AbortController();
    const { body } = request;
    const upload = body === null || body instanceof Bytes ? null : openByteStream(body);
    // Bytes owns a non-shared ArrayBuffer, as required by the Web fetch body.
    const buffered = body instanceof Bytes ? viewOf(body) as Uint8Array<ArrayBuffer> : null;
    const forwardAbort = (): void => controller.abort(env.signal.reason);
    const detach = (): void => env.signal.removeEventListener('abort', forwardAbort);
    if (env.signal.aborted) forwardAbort();
    else env.signal.addEventListener('abort', forwardAbort, { once: true });

    try {
      const init: FetchInit & { duplex?: 'half' } = {
        method: request.method,
        headers,
        signal: controller.signal,
        ...(upload === null ? { body: buffered } : { body: upload.stream, duplex: 'half' }),
      };
      const startedAt = env.clock();
      const response = await fetcher(url, init);
      const headersAt = env.clock();
      await upload?.close();
      const responseHeaders = wrapSensitiveHeaderEntries(response.headers);
      const responseBody = response.body === null ? null : createResponseBody(response.body.getReader(), controller, env);
      return {
        'response.http': {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
          body: responseBody,
          timing: { startedAt, headersAt },
        },
      };
    } catch (error) {
      controller.abort(error);
      if (upload !== null) await Promise.allSettled([upload.close()]);
      throw error;
    } finally {
      // The response body now owns cancellation, including its birth domain.
      detach();
    }
  },
});
