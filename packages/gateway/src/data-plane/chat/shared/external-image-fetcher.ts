import { isNativeFetchTransportError, isUpstreamTransportError } from '../../../dial/transport-error.ts';
import type { Result } from '@floway-dev/pipeline';
import { getExternalResourceFetcher } from '@floway-dev/platform';
import { isAbortError } from '@floway-dev/provider';

const MAX_REDIRECTS = 5;
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type ExternalImageFetchResult =
  | { type: 'success'; finalUrl: URL; status: number; mediaType: string | null; data: Uint8Array }
  | { type: 'invalid-url' }
  | { type: 'invalid-redirect'; status: number; reason: 'missing-location' | 'invalid-location' | 'too-many-redirects' }
  | { type: 'http-error'; status: number }
  | { type: 'too-large'; limitBytes: number }
  | { type: 'empty-body' }
  | { type: 'timeout' }
  | { type: 'transport-error'; error: unknown };

export type ExternalImageFetcher = (url: string) => Promise<ExternalImageFetchResult>;

const parseExternalUrl = (value: string, base?: URL): URL | null => {
  let url: URL;
  try {
    url = new URL(value, base);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  url.hash = '';
  return url;
};

const contentLengthExceedsLimit = (response: Response): boolean => {
  const raw = response.headers.get('content-length');
  if (raw === null) return false;
  const value = Number(raw);
  return Number.isFinite(value) && value > MAX_IMAGE_BYTES;
};

type BoundedBodyResult =
  | { type: 'success'; data: Uint8Array }
  | Extract<ExternalImageFetchResult, { type: 'too-large' | 'empty-body' | 'timeout' | 'transport-error' }>;

const readExternalImageIo = async <T>(
  pending: Promise<T>,
  signal: AbortSignal,
  timeoutSignal: AbortSignal,
): Promise<Result<T, Extract<ExternalImageFetchResult, { type: 'timeout' | 'transport-error' }>>> => {
  try {
    return { ok: true, value: await pending };
  } catch (error) {
    if (timeoutSignal.aborted && error === timeoutSignal.reason) return { ok: false, error: { type: 'timeout' } };
    if (
      (signal.aborted && error === signal.reason)
      || isAbortError(error)
      || isUpstreamTransportError(error)
      || isNativeFetchTransportError(error)
      || (error instanceof Error && 'code' in error && error.code === 'ENETUNREACH')
    ) return { ok: false, error: { type: 'transport-error', error } };
    throw error;
  }
};

const readBoundedBody = async (response: Response, signal: AbortSignal, timeoutSignal: AbortSignal): Promise<BoundedBodyResult> => {
  if (contentLengthExceedsLimit(response)) {
    if (response.body !== null) {
      const cancelled = await readExternalImageIo(response.body.cancel(), signal, timeoutSignal);
      if (!cancelled.ok) return cancelled.error;
    }
    return { type: 'too-large', limitBytes: MAX_IMAGE_BYTES };
  }
  if (response.body === null) return { type: 'empty-body' };

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const read = await readExternalImageIo(reader.read(), signal, timeoutSignal);
      if (!read.ok) return read.error;
      const next = read.value;
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_IMAGE_BYTES) {
        const cancelled = await readExternalImageIo(reader.cancel(), signal, timeoutSignal);
        if (!cancelled.ok) return cancelled.error;
        return { type: 'too-large', limitBytes: MAX_IMAGE_BYTES };
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) return { type: 'empty-body' };

  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { type: 'success', data };
};

const fetchExternalImage = async (initialUrl: URL, downstreamSignal?: AbortSignal): Promise<ExternalImageFetchResult> => {
  const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const signal = downstreamSignal === undefined
    ? timeoutSignal
    : AbortSignal.any([downstreamSignal, timeoutSignal]);
  let url = initialUrl;

  const fetcher = getExternalResourceFetcher();
  for (let redirectCount = 0; ; redirectCount++) {
    if (signal.aborted) {
      return signal.reason === timeoutSignal.reason ? { type: 'timeout' } : { type: 'transport-error', error: signal.reason };
    }
    const fetched = await readExternalImageIo(fetcher(url, signal), signal, timeoutSignal);
    if (!fetched.ok) return fetched.error;
    const response = fetched.value;
    if (response.ok) {
      const body = await readBoundedBody(response, signal, timeoutSignal);
      if (body.type !== 'success') return body;
      return {
        type: 'success',
        finalUrl: url,
        status: response.status,
        mediaType: response.headers.get('content-type'),
        data: body.data,
      };
    }
    if (response.body !== null) {
      const cancelled = await readExternalImageIo(response.body.cancel(), signal, timeoutSignal);
      if (!cancelled.ok) return cancelled.error;
    }
    if (!REDIRECT_STATUSES.has(response.status)) return { type: 'http-error', status: response.status };
    if (redirectCount >= MAX_REDIRECTS) {
      return { type: 'invalid-redirect', status: response.status, reason: 'too-many-redirects' };
    }
    const location = response.headers.get('location');
    if (location === null) return { type: 'invalid-redirect', status: response.status, reason: 'missing-location' };
    const redirected = parseExternalUrl(location, url);
    if (redirected === null) return { type: 'invalid-redirect', status: response.status, reason: 'invalid-location' };
    url = redirected;
  }
};

export const createExternalImageFetcher = (downstreamSignal?: AbortSignal): ExternalImageFetcher => {
  const requests = new Map<string, Promise<ExternalImageFetchResult>>();
  return value => {
    if (downstreamSignal?.aborted) return Promise.resolve({ type: 'transport-error', error: downstreamSignal.reason });
    const url = parseExternalUrl(value);
    if (url === null) return Promise.resolve({ type: 'invalid-url' });
    const cached = requests.get(url.href);
    if (cached !== undefined) return cached;
    const request = fetchExternalImage(url, downstreamSignal);
    requests.set(url.href, request);
    return request;
  };
};
