import { isNativeFetchTransportError, isUpstreamTransportError } from '../../../../dial/transport-error.ts';
import { isJsonObject } from '../../../../shared/json-helpers.ts';
import { sleep } from '../../../../shared/sleep.ts';
import type { WebSearchProviderErrorCode, WebSearchProviderResult } from '../types.ts';
import type { Result } from '@floway-dev/pipeline';
import { isAbortError } from '@floway-dev/provider';

const MAX_WEB_SEARCH_QUERY_LENGTH = 1000;
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000] as const;
const RETRYABLE_HTTP_STATUS: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);

export const readWebSearchIo = async <T>(pending: Promise<T>, signal?: AbortSignal): Promise<Result<T, unknown>> => {
  try {
    return { ok: true, value: await pending };
  } catch (error) {
    if ((signal?.aborted && error === signal.reason) || isAbortError(error) || isUpstreamTransportError(error) || isNativeFetchTransportError(error)) {
      return { ok: false, error };
    }
    throw error;
  }
};

export const webSearchUnavailable = (error: unknown) => ({
  type: 'error' as const,
  errorCode: 'unavailable' as const,
  message: error instanceof Error ? error.message : String(error),
});

export const fetchWithRetry = async (
  doFetch: () => Promise<Response>,
  signal?: AbortSignal,
): Promise<Result<Response, unknown>> => {
  let attempt = 0;
  while (true) {
    const fetched = await readWebSearchIo(doFetch(), signal);
    if (!fetched.ok || !RETRYABLE_HTTP_STATUS.has(fetched.value.status) || attempt >= RETRY_DELAYS_MS.length) return fetched;
    const body = fetched.value.body;
    if (body !== null) {
      const discarded = await readWebSearchIo(body.cancel(), signal);
      if (!discarded.ok) return discarded;
    }
    const waited = await readWebSearchIo(sleep(RETRY_DELAYS_MS[attempt], signal), signal);
    if (!waited.ok) return waited;
    attempt += 1;
  }
};

export const readWebSearchJson = async (response: Response, signal?: AbortSignal): Promise<Result<unknown, unknown>> => {
  const text = await readWebSearchIo(response.text(), signal);
  if (!text.ok) return text;
  try {
    return { ok: true, value: JSON.parse(text.value) };
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { ok: false, error };
  }
};

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

const readBodyCapped = async (response: Response, maxBytes: number, signal?: AbortSignal): Promise<Result<string, unknown>> => {
  if (response.body === null) {
    const text = await readWebSearchIo(response.text(), signal);
    return text.ok ? { ok: true, value: text.value.slice(0, maxBytes) } : text;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (totalBytes < maxBytes) {
      const read = await readWebSearchIo(reader.read(), signal);
      if (!read.ok) return read;
      const { value, done } = read.value;
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
  } finally {
    reader.releaseLock();
  }

  if (totalBytes === maxBytes) {
    const discarded = await readWebSearchIo(response.body.cancel(), signal);
    if (!discarded.ok) return discarded;
  }
  return { ok: true, value: new TextDecoder().decode(concatChunks(chunks, totalBytes)) };
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

export const extractWebSearchProviderErrorMessage = async (
  response: Response,
  signal?: AbortSignal,
): Promise<Result<string | undefined, unknown>> => {
  const body = await readBodyCapped(response, MAX_PROVIDER_ERROR_BODY_BYTES, signal);
  if (!body.ok) return body;
  const text = body.value;
  if (text.length === 0) return { ok: true, value: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { ok: true, value: text };
  }
  if (!isJsonObject(parsed)) return { ok: true, value: text };

  // Microsoft Web IQ reports userMessage and technicalDetails on error.
  // https://api.microsoft.ai/v3/search/web
  for (const candidate of [
    parsed.detail,
    isJsonObject(parsed.error) ? parsed.error.message : parsed.error,
    parsed.message,
    parsed.userMessage,
    parsed.technicalDetails,
  ]) {
    if (typeof candidate === 'string') return { ok: true, value: candidate };
  }
  return { ok: true, value: text };
};
