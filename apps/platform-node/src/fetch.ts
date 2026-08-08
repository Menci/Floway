import { isReplayableBody, type Fetcher } from '@floway-dev/http';

export const nodeFetch: Fetcher = (url, init) => {
  const body = init.body;
  if (!isReplayableBody(body)) return fetch(url, { ...init, body });
  if (!Number.isSafeInteger(body.contentLength) || body.contentLength < 0) {
    return Promise.reject(new RangeError('Replayable body content length must be a non-negative safe integer'));
  }
  const headers = new Headers(init.headers);
  headers.set('content-length', String(body.contentLength));
  // Node's fetch (Undici) requires duplex='half' whenever RequestInit.body is a stream.
  // https://github.com/nodejs/undici/blob/7392d6f9f565e550e9047458c275ae77aeaefbb9/lib/web/fetch/request.js#L538-L542
  const request: RequestInit & { duplex: 'half' } = {
    ...init,
    body: body.open(),
    headers,
    duplex: 'half',
  };
  return fetch(url, request);
};
