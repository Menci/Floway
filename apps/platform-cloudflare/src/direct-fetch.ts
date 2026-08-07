import { isReplayableBody, type Fetcher } from '@floway-dev/http';

interface FixedLengthStreamConstructor {
  new(contentLength: number): {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<ArrayBuffer | ArrayBufferView>;
  };
}

declare const FixedLengthStream: FixedLengthStreamConstructor;

export const cloudflareDirectFetch: Fetcher = (url, init) => {
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
  return Promise.all([
    fetch(url, { ...init, body: fixed.readable }),
    transfer,
  ]).then(([response]) => response);
};
