import { extractWebSearchProviderErrorMessage, httpStatusToErrorCode, toWebSearchTextBlocks, validateWebSearchQuery } from './shared.ts';
import { truncateUtf8 } from './truncate.ts';
import { isJsonObject } from '../../../../shared/json-helpers.ts';
import { normalizeDomainList } from '../domain-normalize.ts';
import {
  DEFAULT_WEB_SEARCH_RESULT_COUNT,
  MAX_FETCH_PAGE_BYTES,
  type WebSearchFetchPageRequest,
  type WebSearchFetchPageResult,
  type WebSearchProvider,
  type WebSearchProviderErrorCode,
  type WebSearchProviderRequest,
  type WebSearchProviderResult,
} from '../types.ts';

const TAVILY_SEARCH_URL = 'https://api.tavily.com/search';
// Tavily Extract batches multiple URLs in one POST so the shim's
// open-page step costs one upstream call per turn.
//   https://docs.tavily.com/documentation/api-reference/extract
const TAVILY_EXTRACT_URL = 'https://api.tavily.com/extract';

// Tavily accepts `include_domains` / `exclude_domains` as bare
// hostnames. Returning `undefined` for an empty list omits the field
// entirely, matching how Tavily distinguishes "no filter" from "filter
// to empty set".
const tavilyDomainList = (domains?: string[]): string[] | undefined => {
  const normalized = normalizeDomainList(domains);
  return normalized.length > 0 ? normalized : undefined;
};

const normalizeResult = (value: unknown): Extract<WebSearchProviderResult, { type: 'ok' }>['results'][number] | null => {
  if (!isJsonObject(value) || typeof value.title !== 'string' || typeof value.url !== 'string') {
    return null;
  }

  return {
    source: value.url,
    title: value.title,
    pageAge: typeof value.published_date === 'string' && value.published_date.trim().length > 0 ? value.published_date : undefined,
    content: toWebSearchTextBlocks(value.content),
  };
};

interface TavilyExtractResultEntry {
  url: string;
  raw_content?: string;
  title?: string;
}

interface TavilyExtractFailedEntry {
  url: string;
  error?: string;
}

export const createTavilyWebSearchProvider = (apiKey: string, deps?: { fetch?: typeof fetch }): WebSearchProvider => {
  const httpFetch = deps?.fetch ?? fetch;

  const search = async (request: WebSearchProviderRequest): Promise<WebSearchProviderResult> => {
    const validatedQuery = validateWebSearchQuery(request.query);
    if (validatedQuery.type === 'error') {
      return validatedQuery.result;
    }

    const includeDomains = tavilyDomainList(request.allowedDomains);
    const excludeDomains = tavilyDomainList(request.blockedDomains);
    const body: Record<string, unknown> = {
      query: validatedQuery.query,
      max_results: request.maxResults ?? DEFAULT_WEB_SEARCH_RESULT_COUNT,
    };
    if (typeof request.userLocation?.country === 'string' && request.userLocation.country.trim().length > 0) {
      body.country = request.userLocation.country.trim();
    }
    if (includeDomains) {
      body.include_domains = includeDomains;
    }
    if (excludeDomains) {
      body.exclude_domains = excludeDomains;
    }

    try {
      const response = await httpFetch(TAVILY_SEARCH_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        ...(request.signal !== undefined ? { signal: request.signal } : {}),
      });

      if (!response.ok) {
        const message = await extractWebSearchProviderErrorMessage(response);
        if (response.status === 429) {
          return {
            type: 'error',
            errorCode: httpStatusToErrorCode(response.status),
            message: message ?? 'Tavily rate limited the request.',
          };
        }

        if (response.status === 400) {
          return {
            type: 'error',
            errorCode: httpStatusToErrorCode(response.status),
            message: message ?? 'Tavily rejected the search query.',
          };
        }

        if (response.status === 413) {
          return {
            type: 'error',
            errorCode: httpStatusToErrorCode(response.status),
            message: message ?? 'Tavily rejected the request as too large.',
          };
        }

        return {
          type: 'error',
          errorCode: httpStatusToErrorCode(response.status),
          message: message ?? 'Tavily search failed.',
        };
      }

      const payload = await response.json();
      const limit = request.maxResults ?? DEFAULT_WEB_SEARCH_RESULT_COUNT;
      // Unexpected payload shape is a backend contract violation;
      // returning empty results would mask a real Tavily outage.
      if (!isJsonObject(payload) || !Array.isArray(payload.results)) {
        return {
          type: 'error',
          errorCode: 'unavailable',
          message: 'Tavily returned an unexpected payload shape; check provider status.',
        };
      }
      const results = payload.results.map(normalizeResult).filter((entry): entry is NonNullable<typeof entry> => entry !== null);

      return {
        type: 'ok',
        results: results.slice(0, limit),
      };
    } catch (error) {
      return {
        type: 'error',
        errorCode: 'unavailable',
        message: error instanceof Error ? error.message : 'Tavily search failed.',
      };
    }
  };

  const fetchPage = async (request: WebSearchFetchPageRequest): Promise<WebSearchFetchPageResult> => {
    try {
      const response = await httpFetch(TAVILY_EXTRACT_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          urls: request.urls,
          extract_depth: 'basic',
          format: 'markdown',
        }),
        ...(request.signal !== undefined ? { signal: request.signal } : {}),
      });

      if (!response.ok) {
        const message = await extractWebSearchProviderErrorMessage(response);
        const errorCode: WebSearchProviderErrorCode = httpStatusToErrorCode(response.status);
        // Tavily extract is one batch call, so non-2xx applies to the
        // whole batch. Per-URL granularity only comes through
        // `failed_results` inside a 200.
        return {
          type: 'error',
          errorCode,
          message: message ?? `Tavily extract failed (HTTP ${response.status}).`,
        };
      }

      const payload = await response.json();
      if (!isJsonObject(payload)) {
        return { type: 'error', errorCode: 'unavailable', message: 'Tavily extract returned an unexpected payload.' };
      }

      // 200 with neither `results` nor `failed_results` is a Tavily
      // outage masquerading as success. Tavily routinely omits one of
      // the two depending on outcome, so missing-one is fine; missing
      // both isn't.
      const resultsIsArray = Array.isArray(payload.results);
      const failedIsArray = Array.isArray(payload.failed_results);
      if (!resultsIsArray && !failedIsArray) {
        return {
          type: 'error',
          errorCode: 'unavailable',
          message: 'Tavily extract returned an unexpected payload shape; check provider status.',
        };
      }

      const rawResults: TavilyExtractResultEntry[] = resultsIsArray
        ? (payload.results as unknown[]).filter((entry): entry is TavilyExtractResultEntry => isJsonObject(entry) && typeof entry.url === 'string')
        : [];
      const rawFailures: TavilyExtractFailedEntry[] = failedIsArray
        ? (payload.failed_results as unknown[]).filter((entry): entry is TavilyExtractFailedEntry => isJsonObject(entry) && typeof entry.url === 'string')
        : [];

      const pages = rawResults.map(entry => {
        const truncated = truncateUtf8(typeof entry.raw_content === 'string' ? entry.raw_content : '', MAX_FETCH_PAGE_BYTES);
        return {
          url: entry.url,
          ...(typeof entry.title === 'string' && entry.title.length > 0 ? { title: entry.title } : {}),
          content: truncated.content,
          truncated: truncated.truncated,
          fullContentBytes: truncated.fullContentBytes,
        };
      });

      const failures = rawFailures.map(entry => ({
        url: entry.url,
        errorCode: 'unavailable' as const,
        ...(typeof entry.error === 'string' && entry.error.length > 0 ? { message: entry.error } : {}),
      }));

      return { type: 'ok', pages, failures };
    } catch (error) {
      return {
        type: 'error',
        errorCode: 'unavailable',
        message: error instanceof Error ? error.message : 'Tavily extract failed.',
      };
    }
  };

  return { search, fetchPage };
};
