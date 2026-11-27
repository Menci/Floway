import { isNodeContentDataError } from './http-content-decoders.ts';
import { isNodeConnectFailure, isNodeSocketFailure } from './network-failure.ts';
import { fetchWithTransportErrors, isReplayableBody, toRequestInit, trackReadableFailure, type Fetcher } from '@floway-dev/http';

// https://github.com/nodejs/undici/blob/7392d6f9f565e550e9047458c275ae77aeaefbb9/lib/core/errors.js#L20-L35
// https://github.com/nodejs/undici/blob/7392d6f9f565e550e9047458c275ae77aeaefbb9/lib/core/errors.js#L254-L270
const socketErrorBrand = Symbol.for('undici.error.UND_ERR_SOCKET');
const timeoutErrorBrand = Symbol.for('undici.error.UND_ERR_CONNECT_TIMEOUT');
const headTimeoutErrorBrand = Symbol.for('undici.error.UND_ERR_HEADERS_TIMEOUT');
const bodyTimeoutErrorBrand = Symbol.for('undici.error.UND_ERR_BODY_TIMEOUT');
const responseLengthErrorBrand = Symbol.for('undici.error.UND_ERR_RES_CONTENT_LENGTH_MISMATCH');
const httpParserErrorBrand = Symbol.for('undici.error.UND_ERR_HTTP_PARSER');

const isBrandedFailure = (cause: unknown, code: string, brand: symbol): boolean => cause instanceof Error
  && (cause as Error & { code?: string }).code === code
  && (cause as Error & Record<symbol, unknown>)[brand] === true;

const isSocketFailure = (cause: unknown): boolean => isBrandedFailure(cause, 'UND_ERR_SOCKET', socketErrorBrand);

// Undici brands HTTP/1.1 wire errors and derives their codes from llhttp.
// https://github.com/nodejs/node/blob/60553651579ec33ca1aef9e1eedab2c3855f1f7e/deps/undici/src/lib/core/errors.js#L295-L309
// https://github.com/nodejs/node/blob/60553651579ec33ca1aef9e1eedab2c3855f1f7e/deps/undici/src/lib/dispatcher/client-h1.js#L338-L349
const isHttpParserFailure = (cause: unknown): boolean => cause instanceof Error
  && (cause as Error & Record<symbol, unknown>)[httpParserErrorBrand] === true
  && 'code' in cause && typeof cause.code === 'string' && cause.code.startsWith('HPE_');

const isFetchTransportFailure = (failure: unknown): boolean => failure instanceof TypeError
  && failure.message === 'fetch failed'
  && (isSocketFailure(failure.cause)
    || isHttpParserFailure(failure.cause)
    || isBrandedFailure(failure.cause, 'UND_ERR_CONNECT_TIMEOUT', timeoutErrorBrand)
    || isBrandedFailure(failure.cause, 'UND_ERR_HEADERS_TIMEOUT', headTimeoutErrorBrand)
    || isNodeConnectFailure(failure.cause));

// Undici retains the original error on an interrupted body.
// https://github.com/nodejs/node/blob/aa4c77582be995286fc6e00aaf530dc7ade102a9/deps/undici/src/lib/web/fetch/index.js#L2031-L2052
// https://github.com/nodejs/node/blob/aa4c77582be995286fc6e00aaf530dc7ade102a9/deps/undici/src/lib/dispatcher/client-h1.js#L305-L348
const isBodyTransportFailure = (failure: unknown): boolean => {
  if (!(failure instanceof TypeError) || failure.message !== 'terminated') return false;
  const { cause } = failure;
  return isSocketFailure(cause)
    || isHttpParserFailure(cause)
    || isBrandedFailure(cause, 'UND_ERR_BODY_TIMEOUT', bodyTimeoutErrorBrand)
    || isBrandedFailure(cause, 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH', responseLengthErrorBrand)
    || isNodeContentDataError(cause)
    || (isNodeSocketFailure(cause) && cause.syscall === 'read');
};

const network = {
  isFetchTransportFailure,
  classifyBodyFailure: (cause: unknown) => isBodyTransportFailure(cause) ? { kind: 'transport' as const, cause } : undefined,
};

export const nodeFetch: Fetcher = async (url, init) => {
  const body = init.body;
  if (!isReplayableBody(body)) {
    if (!(body instanceof ReadableStream)) return await fetchWithTransportErrors(url, toRequestInit(init, body), network);
    const upload = trackReadableFailure(body);
    const request = { ...toRequestInit(init, upload.body), duplex: 'half' } satisfies RequestInit & { duplex: 'half' };
    return await fetchWithTransportErrors(url, request, { ...network, upload });
  }
  if (!Number.isSafeInteger(body.contentLength) || body.contentLength < 0) {
    throw new RangeError('Replayable body content length must be a non-negative safe integer');
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
  return await fetchWithTransportErrors(url, request, { ...network, upload });
};
