import { getHeader, isHttpBodyStream, materializeHeaders, setHeader, type HttpResponseFact, type HttpStreamError } from '@floway-dev/http';
import type { ManagedStream } from '@floway-dev/pipeline';

const encoder = new TextEncoder();

export const responseHead = (status: number, statusText = ''): HttpResponseFact => ({ status, statusText, headers: [], body: null });

export const jsonResponseBody = (http: HttpResponseFact, value: unknown): HttpResponseFact => {
  const contentType = getHeader(http.headers, 'content-type');
  const headers = typeof contentType === 'string' && /(?:\/|\+)json(?:\s*;|$)/i.test(contentType)
    ? http.headers
    : setHeader(http.headers, 'content-type', 'application/json');
  const text = JSON.stringify(value);
  if (text === undefined) throw new TypeError('Expected a JSON-serializable protocol outcome');
  return { ...http, headers, body: encoder.encode(text) };
};

const arrayBufferBytes = (bytes: Uint8Array): Uint8Array<ArrayBuffer> =>
  bytes.buffer instanceof ArrayBuffer ? bytes as Uint8Array<ArrayBuffer> : new Uint8Array(bytes);

const deliveryStream = (body: ManagedStream<Uint8Array, HttpStreamError>, controller: AbortController): ReadableStream<Uint8Array> => {
  const cursor = body[Symbol.asyncIterator]();
  const { signal } = controller;
  let outcome = false;
  let pending = Promise.resolve();
  let draining: Promise<void> | undefined;
  let onAbort: () => void;

  const drain = (after: Promise<void>): Promise<void> => draining ??= after.then(async () => {
    while (!(await cursor.next()).done) {
      // The response's managed stream still owns its upstream through native done.
    }
  });
  const finish = (reason?: unknown): void => {
    outcome = true;
    signal.removeEventListener('abort', onAbort);
    controller.abort(reason);
  };

  return new ReadableStream<Uint8Array>({
    start(output) {
      onAbort = () => {
        finish(signal.reason);
        output.error(signal.reason);
        // A panic during the drain also rejects the host's run.done.
        void drain(pending).catch(() => undefined);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    },
    pull(output) {
      pending = (async () => {
        try {
          const item = await cursor.next();
          if (outcome) return;
          if (item.done) {
            finish();
            output.close();
          } else if (item.value.ok) {
            output.enqueue(item.value.value);
          } else {
            finish(item.value.error.cause);
            output.error(item.value.error.cause);
            await drain(Promise.resolve());
          }
        } catch (error) {
          finish(error);
          throw error;
        }
      })();
      return pending;
    },
    cancel(reason) {
      finish(reason);
      return drain(pending);
    },
  }, { highWaterMark: 0 });
};

export const writeHttpResponse = (http: HttpResponseFact, controller: AbortController): Response => {
  const { body, status, statusText } = http;
  const headers = materializeHeaders(http.headers);
  const bodyless = status === 204 || status === 205 || status === 304;
  if (isHttpBodyStream(body)) {
    const stream = deliveryStream(body, controller);
    if (bodyless) {
      // Fetch disallows a body on these statuses, including an empty stream.
      void stream.cancel().catch(() => undefined);
      return new Response(null, { status, statusText, headers });
    }
    return new Response(stream, { status, statusText, headers });
  }
  controller.abort();
  if (body !== null && !(body instanceof Uint8Array)) throw new TypeError('Expected a rendered HTTP response body');
  return new Response(bodyless || body === null ? null : arrayBufferBytes(body), { status, statusText, headers });
};
