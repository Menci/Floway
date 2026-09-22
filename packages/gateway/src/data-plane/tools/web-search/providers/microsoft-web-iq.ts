import { extractWebSearchProviderErrorMessage, fetchWithRetry, httpStatusToErrorCode, toWebSearchTextBlocks, validateWebSearchQuery } from './shared.ts';
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

// Microsoft publishes api.microsoft.ai/v3 as Web IQ's REST API base.
// https://webiq.microsoft.ai/documentation/quick-start/
const MICROSOFT_WEB_IQ_SEARCH_URL = 'https://api.microsoft.ai/v3/search/web';
// Microsoft Web IQ's `browse` API is single-URL; we issue Promise.all over the batch.
// Per-iteration concurrency is naturally bounded by the shim's iteration cap
// (~30) and the model's parallel call count (≤4 in practice).
// https://webiq.microsoft.ai/documentation/quick-start/
const MICROSOFT_WEB_IQ_BROWSE_URL = 'https://api.microsoft.ai/v3/browse';

const toMicrosoftQuery = (request: WebSearchProviderRequest, query: string) => {
  // Microsoft Web IQ has no allow/block-domain fields, so domain
  // policy is biased through `site:` / `-site:` operators. Best-effort,
  // not strict. Smuggled query fragments (e.g. `example.com OR
  // site:evil.com`) get rejected at normalization.
  const allowedSites = normalizeDomainList(request.allowedDomains).map(domain => `site:${domain}`);
  const blockedSites = normalizeDomainList(request.blockedDomains).map(domain => `-site:${domain}`);
  return [query, ...allowedSites, ...blockedSites].join(' ');
};

const toMicrosoftRegion = (userLocation: WebSearchProviderRequest['userLocation']): string | undefined => {
  const candidate = userLocation?.country?.trim();
  return candidate && /^[a-z]{2}$/i.test(candidate) ? candidate.toUpperCase() : undefined;
};

const normalizeResult = (value: unknown): Extract<WebSearchProviderResult, { type: 'ok' }>['results'][number] | null => {
  if (!isJsonObject(value) || typeof value.title !== 'string' || typeof value.url !== 'string') {
    return null;
  }

  const pageAge =
    typeof value.lastUpdatedAt === 'string' && value.lastUpdatedAt.trim().length > 0
      ? value.lastUpdatedAt
      : typeof value.crawledAt === 'string' && value.crawledAt.trim().length > 0
        ? value.crawledAt
        : undefined;

  return {
    source: value.url,
    title: value.title,
    pageAge,
    content: toWebSearchTextBlocks(value.content),
  };
};

// One /v3/browse outcome. The fetchPage batch aggregates these and
// collapses to a {type:'error'} envelope only when every URL hard-failed.
type BrowseOutcome =
  | { kind: 'ok'; url: string; data: { url: string; title?: string; content?: string; lastUpdatedAt?: string; crawledAt?: string } }
  | { kind: 'cold'; url: string }
  | { kind: 'fail'; url: string; httpStatus: number; message: string };

const browseOneUrl = async (httpFetch: typeof fetch, apiKey: string, url: string, signal?: AbortSignal): Promise<BrowseOutcome> => {
  try {
    const response = await fetchWithRetry(() => httpFetch(MICROSOFT_WEB_IQ_BROWSE_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-apikey': apiKey,
      },
      body: JSON.stringify({
        url,
        maxLength: 50_000,
        liveCrawl: 'fallback',
        contentFormat: 'markdown',
        renderDynamicPages: true,
      }),
      ...(signal !== undefined ? { signal } : {}),
    }), signal);

    // Microsoft Web IQ returns 202 with `retryAfter` when the page isn't
    // cached and a live crawl was kicked off. Don't poll — Workers
    // can't afford the budget and re-issuing from the next model turn
    // is fine.
    if (response.status === 202) {
      return { kind: 'cold', url };
    }

    if (!response.ok) {
      const message = (await extractWebSearchProviderErrorMessage(response)) ?? `HTTP ${response.status}`;
      return { kind: 'fail', url, httpStatus: response.status, message };
    }

    const payload = await response.json();
    if (!isJsonObject(payload) || typeof payload.url !== 'string') {
      return { kind: 'fail', url, httpStatus: response.status, message: 'Microsoft Web IQ browse returned an unexpected payload.' };
    }
    return {
      kind: 'ok',
      url,
      data: {
        url: payload.url,
        ...(typeof payload.title === 'string' ? { title: payload.title } : {}),
        ...(typeof payload.content === 'string' ? { content: payload.content } : {}),
        ...(typeof payload.lastUpdatedAt === 'string' ? { lastUpdatedAt: payload.lastUpdatedAt } : {}),
        ...(typeof payload.crawledAt === 'string' ? { crawledAt: payload.crawledAt } : {}),
      },
    };
  } catch (error) {
    return { kind: 'fail', url, httpStatus: 0, message: error instanceof Error ? error.message : String(error) };
  }
};

export const createMicrosoftWebIqWebSearchProvider = (apiKey: string, deps?: { fetch?: typeof fetch }): WebSearchProvider => {
  const httpFetch = deps?.fetch ?? fetch;

  const search = async (request: WebSearchProviderRequest): Promise<WebSearchProviderResult> => {
    const validatedQuery = validateWebSearchQuery(request.query);
    if (validatedQuery.type === 'error') {
      return validatedQuery.result;
    }

    const limit = request.maxResults ?? DEFAULT_WEB_SEARCH_RESULT_COUNT;
    const body: Record<string, unknown> = {
      query: toMicrosoftQuery(request, validatedQuery.query),
      count: limit,
      contentFormat: 'passage',
    };
    const region = toMicrosoftRegion(request.userLocation);
    if (region) {
      body.region = region;
    }

    try {
      const response = await fetchWithRetry(() => httpFetch(MICROSOFT_WEB_IQ_SEARCH_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-apikey': apiKey,
        },
        body: JSON.stringify(body),
        ...(request.signal !== undefined ? { signal: request.signal } : {}),
      }), request.signal);

      if (response.ok) {
        const payload = await response.json();
        // Unexpected payload shape is a backend contract violation;
        // returning empty results would mask a real Microsoft Web IQ outage.
        if (!isJsonObject(payload) || !Array.isArray(payload.webResults)) {
          return {
            type: 'error',
            errorCode: 'unavailable',
            message: 'Microsoft Web IQ returned an unexpected payload shape; check provider status.',
          };
        }
        const results = payload.webResults.map(normalizeResult).filter((entry): entry is NonNullable<typeof entry> => entry !== null);

        return {
          type: 'ok',
          results: results.slice(0, limit),
        };
      }

      const message = await extractWebSearchProviderErrorMessage(response);

      if (response.status === 429) {
        return {
          type: 'error',
          errorCode: httpStatusToErrorCode(response.status),
          message: message ?? 'Microsoft Web IQ rate limited the request.',
        };
      }

      if (response.status === 400) {
        return {
          type: 'error',
          errorCode: httpStatusToErrorCode(response.status),
          message: message ?? 'Microsoft Web IQ rejected the search query.',
        };
      }

      if (response.status === 413) {
        return {
          type: 'error',
          errorCode: httpStatusToErrorCode(response.status),
          message: message ?? 'Microsoft Web IQ rejected the request as too large.',
        };
      }

      return {
        type: 'error',
        errorCode: httpStatusToErrorCode(response.status),
        message: message ?? 'Microsoft Web IQ search failed.',
      };
    } catch (error) {
      return {
        type: 'error',
        errorCode: 'unavailable',
        message: error instanceof Error ? error.message : 'Microsoft Web IQ search failed.',
      };
    }
  };

  const fetchPage = async (request: WebSearchFetchPageRequest): Promise<WebSearchFetchPageResult> => {
    if (request.urls.length === 0) {
      return { type: 'ok', pages: [], failures: [] };
    }

    const outcomes = await Promise.all(request.urls.map(url => browseOneUrl(httpFetch, apiKey, url, request.signal)));

    // Whole-batch failure (every URL transport-failed or 5xx) collapses
    // into one {type:'error'} envelope; 4xx/202 stay per-URL so one bad
    // URL doesn't poison the batch.
    const allHardFail = outcomes.every(outcome => outcome.kind === 'fail' && (outcome.httpStatus === 0 || outcome.httpStatus >= 500));
    if (allHardFail) {
      const first = outcomes[0] as Extract<BrowseOutcome, { kind: 'fail' }>;
      return { type: 'error', errorCode: 'unavailable', message: first.message };
    }

    const pages: Extract<WebSearchFetchPageResult, { type: 'ok' }>['pages'] = [];
    const failures: Extract<WebSearchFetchPageResult, { type: 'ok' }>['failures'] = [];

    for (const outcome of outcomes) {
      if (outcome.kind === 'ok') {
        const truncated = truncateUtf8(outcome.data.content ?? '', MAX_FETCH_PAGE_BYTES);
        pages.push({
          url: outcome.data.url,
          ...(outcome.data.title !== undefined ? { title: outcome.data.title } : {}),
          content: truncated.content,
          truncated: truncated.truncated,
          fullContentBytes: truncated.fullContentBytes,
        });
        continue;
      }

      if (outcome.kind === 'cold') {
        failures.push({ url: outcome.url, errorCode: 'unavailable', message: 'live crawl pending' });
        continue;
      }

      // 430 is the Browse-only "Too Many On-Demand Crawls" signal.
      const errorCode: WebSearchProviderErrorCode = outcome.httpStatus === 430
        ? 'too_many_requests'
        : httpStatusToErrorCode(outcome.httpStatus);
      failures.push({ url: outcome.url, errorCode, message: outcome.message });
    }

    return { type: 'ok', pages, failures };
  };

  return { search, fetchPage };
};
