import { isReplayableBody, type Fetcher } from '@floway-dev/http';

interface FixedLengthStreamConstructor {
  new(contentLength: number): {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<ArrayBuffer | ArrayBufferView>;
  };
}

declare const FixedLengthStream: FixedLengthStreamConstructor;

export const cloudflareFetch: Fetcher = (url, init) => {
  const body = init.body;
  if (!isReplayableBody(body)) return fetch(url, { ...init, body });
  if (!Number.isSafeInteger(body.contentLength) || body.contentLength < 0) {
    return Promise.reject(new RangeError('Replayable body content length must be a non-negative safe integer'));
  }
  // Workers ignores a user-supplied Content-Length for ordinary streams; its
  // FixedLengthStream is the runtime-owned signal that preserves fixed framing.
  // https://developers.cloudflare.com/workers/runtime-apis/request/#set-the-content-length-header
  const fixed = new FixedLengthStream(body.contentLength);
  const transfer = body.open().pipeTo(fixed.writable);
  // Fetch owns the readable side and propagates upload failures into its own
  // promise. Once it has produced a Response, a rejected pump only means the
  // upstream stopped consuming the request early and must not discard it.
  void transfer.catch(() => undefined);
  return fetch(url, { ...init, body: fixed.readable });
};
