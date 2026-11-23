import type { ProviderServices, ProviderUpstreamBase } from './pipelines.ts';
import { openByteStream, type HttpOutput } from './response-body.ts';
import { isUpstreamTransportError, wrapSensitiveHeaderEntries, type FetchInit, type HttpRequestFacts, type HttpResponseBodyChunk, type HttpUrl } from '@floway-dev/http';
import { Bytes, defineEnding, isManagedStream, snapshotError, type ManagedStream, type Scope } from '@floway-dev/pipeline';
import { viewOf } from '@floway-dev/pipeline/bytes-view';

type HttpInput = {
  readonly 'provider.upstream': ProviderUpstreamBase;
  readonly 'request.http': HttpRequestFacts;
};

const materializeUrl = ({ origin, pathname, query }: HttpUrl): string => {
  if (!query?.length) return `${origin}${pathname}`;
  const search = query.map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(typeof value === 'string' ? value : value.reveal())}`);
  return `${origin}${pathname}?${search.join('&')}`;
};

const createResponseBody = (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  request: AbortController,
  scope: Scope<ProviderServices>,
): ManagedStream<HttpResponseBodyChunk> => {
  let cancellation: Promise<void> | undefined;
  let completedCleanly = false;
  let readFailure: { readonly error: unknown } | undefined;
  const cancel = (reason?: unknown): Promise<void> => {
    cancellation ??= reader.cancel(reason);
    return cancellation;
  };
  return scope.createStream<HttpResponseBodyChunk>({
    label: 'http.body',
    async *iterate({ signal }) {
      // The kernel joins an outstanding pull before it runs onClose.
      const interrupt = (): void => {
        if (completedCleanly || readFailure !== undefined) return;
        // onClose awaits this same cancellation and reports a teardown failure.
        void cancel(signal.reason).catch(() => undefined);
        request.abort(signal.reason);
      };
      signal.addEventListener('abort', interrupt, { once: true });
      try {
        if (signal.aborted) interrupt();
        for (;;) {
          let next: ReadableStreamReadResult<Uint8Array>;
          try {
            next = await reader.read();
          } catch (error) {
            if (signal.aborted) throw error;
            readFailure = { error };
            yield { type: 'transport-error', error: snapshotError(error) };
            return;
          }
          if (next.done) {
            completedCleanly = !signal.aborted;
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
        if (readFailure !== undefined) {
          request.abort(readFailure.error);
        } else if (!completedCleanly) {
          const reason = end.how === 'cancelled' ? end.reason : end.how === 'errored' ? end.error : undefined;
          const settled = cancel(reason);
          request.abort(reason);
          await settled;
        }
      } finally {
        reader.releaseLock();
      }
    },
  });
};

export const httpTerminal = defineEnding<HttpInput, HttpOutput, {}, ProviderServices>({
  name: 'http',
  request: { needs: ['provider.upstream', 'request.http'] },
  return: { provides: ['response.http'] },
  async execute({ 'provider.upstream': upstream, 'request.http': request }, scope) {
    const { body } = request;
    if (body !== null && !(body instanceof Bytes) && !isManagedStream(body)) {
      throw new TypeError('An unparsed client upload error reached the upstream HTTP terminal');
    }
    const fetcher = scope.services.fetcher(upstream.id);
    const url = materializeUrl(request.url);
    const headers = request.headers.map(([key, value]): [string, string] => [key, typeof value === 'string' ? value : value.reveal()]);
    const controller = new AbortController();
    const upload = isManagedStream(body) ? openByteStream(body) : null;
    // Bytes owns a non-shared ArrayBuffer, as required by the Web fetch body.
    const buffered = body instanceof Bytes ? viewOf(body) as Uint8Array<ArrayBuffer> : null;
    const forwardAbort = (): void => controller.abort(scope.signal.reason);
    if (scope.signal.aborted) forwardAbort();
    else scope.signal.addEventListener('abort', forwardAbort, { once: true });

    try {
      const init: FetchInit & { duplex?: 'half' } = {
        method: request.method,
        headers,
        signal: controller.signal,
        ...(upload === null ? { body: buffered } : { body: upload.stream, duplex: 'half' }),
      };
      const startedAt = scope.clock();
      let response: Response;
      try {
        response = await fetcher(url, init);
      } catch (error) {
        controller.abort(error);
        if (upload !== null) await Promise.allSettled([upload.close()]);
        if (scope.signal.aborted || !isUpstreamTransportError(error)) throw error;
        return {
          'response.http': {
            status: 502,
            statusText: '',
            headers: [],
            body: null,
            timing: { startedAt, headersAt: scope.clock() },
            exchange: 'upstream',
            transportError: snapshotError(error),
          },
        };
      }
      const headersAt = scope.clock();
      await upload?.close();
      const responseHeaders = wrapSensitiveHeaderEntries(response.headers);
      const responseBody = response.body === null ? null : createResponseBody(response.body.getReader(), controller, scope);
      return {
        'response.http': {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
          body: responseBody,
          timing: { startedAt, headersAt },
          exchange: 'upstream',
        },
      };
    } catch (error) {
      controller.abort(error);
      throw error;
    } finally {
      // The response body now owns cancellation, including its birth domain.
      scope.signal.removeEventListener('abort', forwardAbort);
    }
  },
});
