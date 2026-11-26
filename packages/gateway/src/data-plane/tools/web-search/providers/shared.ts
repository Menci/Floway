import { isJsonObject } from '../../../../shared/json-helpers.ts';
import { sleep } from '../../../../shared/sleep.ts';
import type { WebSearchProviderErrorCode, WebSearchProviderResult } from '../types.ts';
import { isCausedBy, UpstreamTransportError, type ProviderFetchResult } from '@floway-dev/http';
import type { Result } from '@floway-dev/pipeline';
import { getProviderFetch } from '@floway-dev/platform';
import { discardUpstreamResponse } from '@floway-dev/provider';

const MAX_WEB_SEARCH_QUERY_LENGTH = 1000;
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000] as const;
const RETRYABLE_HTTP_STATUS: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);

export type WebSearchFetcher = (url: string, init: RequestInit) => Promise<ProviderFetchResult>;

export const webSearchFetcher = (fetcher?: typeof fetch): WebSearchFetcher =>
  fetcher === undefined ? getProviderFetch() : async (url, init) => ({ response: await fetcher(url, init) });

export const fetchWebSearch = async (
  fetcher: WebSearchFetcher,
  url: string,
  init: RequestInit,
  retry = false,
): Promise<Result<ProviderFetchResult, UpstreamTransportError>> => {
  let attempt = 0;
  while (true) {
    let fetched: ProviderFetchResult;
    try {
      fetched = await fetcher(url, init);
    } catch (error) {
      if (isCausedBy(error, init.signal?.reason) || !(error instanceof UpstreamTransportError)) throw error;
      return { ok: false, error };
    }
    const { response } = fetched;
    if (!retry || !RETRYABLE_HTTP_STATUS.has(response.status) || attempt >= RETRY_DELAYS_MS.length) {
      return { ok: true, value: fetched };
    }
    const discarded = await readWebSearchBody(fetched, init.signal ?? undefined, discardUpstreamResponse);
    if (!discarded.ok) return discarded;
    await sleep(RETRY_DELAYS_MS[attempt], init.signal ?? undefined);
    attempt += 1;
  }
};

const readWebSearchBody = async <Value>(
  fetched: ProviderFetchResult,
  signal: AbortSignal | undefined,
  read: (response: Response) => Promise<Value>,
): Promise<Result<Value, UpstreamTransportError>> => {
  try {
    return { ok: true, value: await read(fetched.response) };
  } catch (cause) {
    if (isCausedBy(cause, signal?.reason)) throw cause;
    if (cause instanceof UpstreamTransportError) return { ok: false, error: cause };
    const failure = fetched.identifyBodyTransportFailure?.(cause);
    if (failure === undefined) throw cause;
    return { ok: false, error: failure };
  }
};

export const readWebSearchJson = async (fetched: ProviderFetchResult, signal?: AbortSignal): Promise<Result<unknown, UpstreamTransportError | SyntaxError>> => {
  const body = await readWebSearchBody(fetched, signal, response => response.text());
  return body.ok ? parseWebSearchJson(body.value) : body;
};

const parseWebSearchJson = (text: string): Result<unknown, SyntaxError> => {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { ok: false, error };
  }
};

export const readWebSearchDiagnostic = (fetched: ProviderFetchResult, signal?: AbortSignal): Promise<Result<string | undefined, UpstreamTransportError>> =>
  readWebSearchBody(fetched, signal, extractWebSearchProviderErrorMessage);

export const httpStatusToErrorCode = (status: number): WebSearchProviderErrorCode => {
  if (status === 429) return 'too_many_requests';
  if (status === 413) return 'request_too_large';
  if (status === 400) return 'invalid_tool_input';
  return 'unavailable';
};

export type ValidatedWebSearchQuery = { type: 'ok'; query: string } | { type: 'error'; result: WebSearchProviderResult };

export const validateWebSearchQuery = (query: string): ValidatedWebSearchQuery => {
  const normalized = query.trim();
  if (normalized.length === 0) {
    return {
      type: 'error',
      result: {
        type: 'error',
        errorCode: 'invalid_tool_input',
        message: 'Search query must not be empty.',
      },
    };
  }

  if (normalized.length > MAX_WEB_SEARCH_QUERY_LENGTH) {
    return {
      type: 'error',
      result: {
        type: 'error',
        errorCode: 'query_too_long',
        message: 'Search query must be at most 1000 characters.',
      },
    };
  }

  return { type: 'ok', query: normalized };
};

export const toWebSearchTextBlocks = (content: unknown): Array<{ type: 'text'; text: string }> =>
  typeof content === 'string' && content.trim().length > 0 ? [{ type: 'text', text: content.trim() }] : [];

// Cap the diagnostic body read at 8 KiB so a hostile or runaway
// provider can't pin arbitrary memory before we slice it down. Streaming
// from `response.body` stops the read at the cap regardless of
// Content-Length.
const MAX_PROVIDER_ERROR_BODY_BYTES = 8 * 1024;

const readBodyCapped = async (response: Response, maxBytes: number): Promise<string> => {
  // Some Response shims (test doubles, oddball runtimes) leave `body`
  // null even when `text()` works; fall back to a post-read slice.
  if (response.body === null) {
    return (await response.text()).slice(0, maxBytes);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (totalBytes < maxBytes) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      const remaining = maxBytes - totalBytes;
      if (value.byteLength <= remaining) {
        chunks.push(value);
        totalBytes += value.byteLength;
      } else {
        chunks.push(value.subarray(0, remaining));
        totalBytes = maxBytes;
      }
    }
    if (totalBytes === maxBytes) await reader.cancel();
  } finally {
    reader.releaseLock();
  }

  return new TextDecoder().decode(concatChunks(chunks, totalBytes));
};

const concatChunks = (chunks: Uint8Array[], totalBytes: number): Uint8Array => {
  const out = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
};

const extractWebSearchProviderErrorMessage = async (response: Response): Promise<string | undefined> => {
  const text = await readBodyCapped(response, MAX_PROVIDER_ERROR_BODY_BYTES);
  if (text.length === 0) {
    return undefined;
  }

  const decoded = parseWebSearchJson(text);
  if (!decoded.ok) return text;
  const parsed = decoded.value;
  if (!isJsonObject(parsed)) {
    return text;
  }

  if (typeof parsed.detail === 'string') {
    return parsed.detail;
  }
  if (typeof parsed.error === 'string') {
    return parsed.error;
  }
  if (isJsonObject(parsed.error) && typeof parsed.error.message === 'string') {
    return parsed.error.message;
  }
  if (typeof parsed.message === 'string') {
    return parsed.message;
  }
  // Microsoft Web IQ writes the human-readable half of its envelope to `userMessage`
  // and the diagnostic half to `technicalDetails`, alongside `errorCode`,
  // `errorCategory`, `requestId`, and `traceId`. Without this rung the whole
  // envelope reaches the operator as raw JSON. Observed on
  // POST https://api.microsoft.ai/v3/search/web with an invalid key:
  // {"errorCode":"AuthInvalidApiKey","errorCategory":"UserError",
  //  "userMessage":"Invalid API key provided.","technicalDetails":"Invalid API key",…}
  if (typeof parsed.userMessage === 'string') {
    return parsed.userMessage;
  }
  if (typeof parsed.technicalDetails === 'string') {
    return parsed.technicalDetails;
  }
  return text;
};
