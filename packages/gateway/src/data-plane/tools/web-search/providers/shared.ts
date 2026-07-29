import { isJsonObject } from '../../../../shared/json-helpers.ts';
import { sleep } from '../../../../shared/sleep.ts';
import type { WebSearchProviderErrorCode, WebSearchProviderResult } from '../types.ts';

const MAX_WEB_SEARCH_QUERY_LENGTH = 1000;
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000] as const;
const RETRYABLE_HTTP_STATUS: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);

export const fetchWithRetry = async (
  doFetch: () => Promise<Response>,
  signal?: AbortSignal,
): Promise<Response> => {
  let attempt = 0;
  while (true) {
    const response = await doFetch();
    if (!RETRYABLE_HTTP_STATUS.has(response.status)) return response;
    if (attempt >= RETRY_DELAYS_MS.length) return response;
    await sleep(RETRY_DELAYS_MS[attempt], signal);
    attempt += 1;
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
  } finally {
    // Drop the reader lock so cancel() can release the body; otherwise
    // cancel() rejects.
    reader.releaseLock();
    await response.body.cancel().catch(() => undefined);
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

export const extractWebSearchProviderErrorMessage = async (response: Response): Promise<string | undefined> => {
  const text = await readBodyCapped(response, MAX_PROVIDER_ERROR_BODY_BYTES);
  if (text.length === 0) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(text);
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
  } catch {
    return text;
  }

  return text;
};
