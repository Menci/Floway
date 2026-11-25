import { isNodeSocketFailure } from './network-failure.ts';
import { fetchWithTransportErrors, isReplayableBody, toRequestInit, trackReadableFailure, type Fetcher, type ProviderFetcher } from '@floway-dev/http';

// https://github.com/nodejs/undici/blob/7392d6f9f565e550e9047458c275ae77aeaefbb9/lib/core/errors.js#L20-L35
// https://github.com/nodejs/undici/blob/7392d6f9f565e550e9047458c275ae77aeaefbb9/lib/core/errors.js#L254-L270
const socketErrorBrand = Symbol.for('undici.error.UND_ERR_SOCKET');
const timeoutErrorBrand = Symbol.for('undici.error.UND_ERR_CONNECT_TIMEOUT');

const isConnectFailure = (failure: unknown): boolean => {
  if (failure instanceof AggregateError) return failure.errors.length > 0 && failure.errors.every(isConnectFailure);
  if (!(failure instanceof Error)) return false;
  const cause: Error & { code?: string; [socketErrorBrand]?: boolean; [timeoutErrorBrand]?: boolean } = failure;
  return (cause.code === 'UND_ERR_SOCKET' && cause[socketErrorBrand] === true)
    || (cause.code === 'UND_ERR_CONNECT_TIMEOUT' && cause[timeoutErrorBrand] === true)
    || isNodeSocketFailure(cause);
};

const isFetchTransportFailure = (failure: unknown): boolean => failure instanceof TypeError
  && failure.message === 'fetch failed'
  && isConnectFailure(failure.cause);

// Undici forwards the terminal I/O error as the cause of the body rejection.
// https://github.com/nodejs/node/blob/aa4c77582be995286fc6e00aaf530dc7ade102a9/deps/undici/src/lib/web/fetch/index.js#L2031-L2052
// https://github.com/nodejs/node/blob/aa4c77582be995286fc6e00aaf530dc7ade102a9/deps/undici/src/lib/dispatcher/client-h1.js#L305-L348
const isBodyTransportFailure = (failure: unknown): boolean => {
  if (!(failure instanceof TypeError) || failure.message !== 'terminated' || !(failure.cause instanceof Error)) return false;
  // https://github.com/nodejs/undici/blob/7392d6f9f565e550e9047458c275ae77aeaefbb9/lib/core/errors.js#L254-L270
  const cause: Error & { code?: string; [socketErrorBrand]?: boolean } = failure.cause;
  return (cause.code === 'UND_ERR_SOCKET' && cause[socketErrorBrand] === true)
    || cause.code === 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH'
    || cause.code === 'HPE_INVALID_EOF_STATE'
    || (isNodeSocketFailure(cause) && cause.syscall === 'read');
};

export const nodeProviderFetch: ProviderFetcher = (url, init) => {
  const body = init.body;
  if (!isReplayableBody(body)) {
    const upload = body instanceof ReadableStream ? trackReadableFailure(body) : undefined;
    const requestInit = upload === undefined
      ? toRequestInit(init, body)
      : { ...toRequestInit(init, upload.body), duplex: 'half' } satisfies RequestInit & { duplex: 'half' };
    return fetchWithTransportErrors(new Request(url, requestInit), undefined, { upload, isFetchTransportFailure, isBodyTransportFailure });
  }
  if (!Number.isSafeInteger(body.contentLength) || body.contentLength < 0) {
    return Promise.reject(new RangeError('Replayable body content length must be a non-negative safe integer'));
  }
  const headers = new Headers(init.headers);
  headers.set('content-length', String(body.contentLength));
  // Node's fetch (Undici) requires duplex='half' whenever RequestInit.body is a stream.
  // https://github.com/nodejs/undici/blob/7392d6f9f565e550e9047458c275ae77aeaefbb9/lib/web/fetch/request.js#L538-L542
  const upload = trackReadableFailure(body.open());
  const request: RequestInit & { duplex: 'half' } = {
    ...toRequestInit(init, upload.body),
    headers,
    duplex: 'half',
  };
  return fetchWithTransportErrors(url, request, { upload, isFetchTransportFailure, isBodyTransportFailure });
};

export const nodeFetch: Fetcher = async (url, init) => (await nodeProviderFetch(url, init)).response;
