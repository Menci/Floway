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
  type WebSearchProviderRequest,
  type WebSearchProviderResult,
} from '../types.ts';

const JINA_SEARCH_URL = 'https://s.jina.ai/';
const JINA_READER_URL = 'https://r.jina.ai/';

// Per-result content cap (cl100k_base tokens) clipped server-side by
// `X-Max-Tokens` on s.jina.ai. Jina's default scrapes the full readability
// markdown of each result page, which can run into double-digit KB; capping
// to 500 tokens (~2 KB markdown) keeps each Jina result in the same size
// ballpark as Microsoft Web IQ's `passage` mode (~300-400 tokens) and
// Tavily's `basic` mode (~100 tokens / ~400 chars). 500 is also Jina's
// documented minimum — values below trigger `Rejected by validator (v) =>
// v >= 500`. Verified against jina-ai/reader's `tokenTrim` call sites in
// `src/services/snapshot-formatter.ts`; `X-Token-Budget` is the header that's
// silently ignored on search — `X-Max-Tokens` is not.
const JINA_SEARCH_MAX_TOKENS_PER_RESULT = 500;

// Hard cap on Jina's `count` query param (validated server-side as 0..20).
const JINA_SEARCH_MAX_COUNT = 20;

interface JinaEnvelope {
  code: number;
  status?: number;
  data?: unknown;
  name?: string;
  message?: string;
}

interface JinaSearchEntry {
  url: string;
  title: string;
  content?: string;
  description?: string;
  publishedTime?: string;
}

const parseEnvelope = (payload: unknown): JinaEnvelope | null => {
  if (!isJsonObject(payload)) return null;
  if (typeof payload.code !== 'number') return null;
  return {
    code: payload.code,
    status: typeof payload.status === 'number' ? payload.status : undefined,
    data: payload.data,
    name: typeof payload.name === 'string' ? payload.name : undefined,
    message: typeof payload.message === 'string' ? payload.message : undefined,
  };
};

const isAssertionEmptyResults = (envelope: JinaEnvelope): boolean =>
  envelope.name === 'AssertionFailureError'
  && typeof envelope.message === 'string'
  && /no search results/i.test(envelope.message);

// Jina accepts a single hostname per `X-Site` header, or multiple via the
// literal `", "` separator (comma + space). Anything else collapses to a
// single bogus hostname server-side; see `serper-search.ts:209` in
// jina-ai/reader.
const buildSiteHeader = (allowedDomains?: string[]): string | undefined => {
  const normalized = normalizeDomainList(allowedDomains);
  return normalized.length > 0 ? normalized.join(', ') : undefined;
};

const normalizeSearchResult = (value: unknown): Extract<WebSearchProviderResult, { type: 'ok' }>['results'][number] | null => {
  if (!isJsonObject(value) || typeof value.title !== 'string' || typeof value.url !== 'string') {
    return null;
  }
  const entry = value as unknown as JinaSearchEntry;
  // `content` is the readability-extracted markdown (when present, capped to
  // JINA_SEARCH_MAX_TOKENS_PER_RESULT by `X-Max-Tokens`); `description` is
  // the SERP-level snippet that Jina always returns. Prefer the former, fall
  // back to the latter — matches what Tavily and Microsoft Web IQ hand
  // back as result-level `content`.
  const text = entry.content ?? entry.description ?? '';
  return {
    source: entry.url,
    title: entry.title,
    pageAge: typeof entry.publishedTime === 'string' && entry.publishedTime.trim().length > 0 ? entry.publishedTime : undefined,
    content: toWebSearchTextBlocks(text),
  };
};

// Reader returns 200 with a single `data` object (or the wrapped envelope
// shape) — pull out the markdown content and the canonical post-redirect URL.
const extractReaderPage = (envelope: JinaEnvelope, requestedUrl: string): { url: string; title?: string; content: string } | null => {
  if (envelope.code !== 200 || !isJsonObject(envelope.data)) return null;
  const data = envelope.data;
  const url = typeof data.url === 'string' ? data.url : requestedUrl;
  const content = typeof data.content === 'string' ? data.content : '';
  if (typeof data.title === 'string' && data.title.length > 0) {
    return { url, title: data.title, content };
  }
  return { url, content };
};

type ReadOutcome =
  | { kind: 'ok'; url: string; title?: string; content: string }
  | { kind: 'fail'; url: string; httpStatus: number; message: string };

const readOneUrl = async (httpFetch: typeof fetch, apiKey: string, url: string, signal?: AbortSignal): Promise<ReadOutcome> => {
  try {
    const response = await fetchWithRetry(
      () => httpFetch(JINA_READER_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ url }),
        ...(signal !== undefined ? { signal } : {}),
      }),
      signal,
    );

    if (!response.ok) {
      const message = (await extractWebSearchProviderErrorMessage(response)) ?? `HTTP ${response.status}`;
      return { kind: 'fail', url, httpStatus: response.status, message };
    }

    const payload = await response.json();
    const envelope = parseEnvelope(payload);
    if (envelope === null) {
      return { kind: 'fail', url, httpStatus: response.status, message: 'Jina reader returned an unexpected payload shape.' };
    }

    const page = extractReaderPage(envelope, url);
    if (page === null) {
      return { kind: 'fail', url, httpStatus: response.status, message: envelope.message ?? 'Jina reader returned no content.' };
    }

    return { kind: 'ok', ...page };
  } catch (error) {
    // httpStatus=0 signals a transport-level failure (network, abort, etc.)
    // so the batch collapsing rule downstream can distinguish "Jina is
    // unreachable" from "one URL was rejected".
    return { kind: 'fail', url, httpStatus: 0, message: error instanceof Error ? error.message : String(error) };
  }
};

export const createJinaWebSearchProvider = (apiKey: string, deps?: { fetch?: typeof fetch }): WebSearchProvider => {
  const httpFetch = deps?.fetch ?? fetch;

  const search = async (request: WebSearchProviderRequest): Promise<WebSearchProviderResult> => {
    const validatedQuery = validateWebSearchQuery(request.query);
    if (validatedQuery.type === 'error') {
      return validatedQuery.result;
    }

    const limit = Math.min(request.maxResults ?? DEFAULT_WEB_SEARCH_RESULT_COUNT, JINA_SEARCH_MAX_COUNT);
    const params = new URLSearchParams({
      q: validatedQuery.query,
      count: String(limit),
    });
    // Jina takes Google's `gl` (geographic location) as a lowercase
    // ISO-3166-1 alpha-2 code. There is no equivalent `X-Country` header
    // despite the name suggesting one — confirmed by grepping the
    // open-source jina-ai/reader codebase.
    const country = request.userLocation?.country?.trim();
    if (country && /^[a-z]{2}$/i.test(country)) {
      params.set('gl', country.toLowerCase());
    }

    const headers: Record<string, string> = {
      authorization: `Bearer ${apiKey}`,
      accept: 'application/json',
      'x-max-tokens': String(JINA_SEARCH_MAX_TOKENS_PER_RESULT),
    };
    const siteHeader = buildSiteHeader(request.allowedDomains);
    if (siteHeader !== undefined) {
      headers['x-site'] = siteHeader;
    }
    // Jina has no exclude-domains operator (no `-site:` builder, no
    // counterpart to Tavily's `exclude_domains`). Silently drop
    // `blockedDomains` rather than reject the search — giving the agent
    // more results, even ones it might filter post-hoc, beats failing a
    // call it could have used.

    try {
      const response = await httpFetch(`${JINA_SEARCH_URL}?${params.toString()}`, {
        method: 'GET',
        headers,
        ...(request.signal !== undefined ? { signal: request.signal } : {}),
      });

      const payload = await response.json().catch(() => null);
      const envelope = parseEnvelope(payload);

      if (!response.ok) {
        // Jina returns "no results" as an HTTP 4xx with
        // `AssertionFailureError`. Surface that as an empty result list
        // instead of a hard error, matching how Tavily and Microsoft Web IQ
        // hand back an empty `results` array on no hits.
        if (envelope !== null && isAssertionEmptyResults(envelope)) {
          return { type: 'ok', results: [] };
        }
        return {
          type: 'error',
          errorCode: httpStatusToErrorCode(response.status),
          message: envelope?.message ?? `Jina search failed (HTTP ${response.status}).`,
        };
      }

      if (envelope === null || !Array.isArray(envelope.data)) {
        return {
          type: 'error',
          errorCode: 'unavailable',
          message: 'Jina search returned an unexpected payload shape; check provider status.',
        };
      }

      const results = envelope.data
        .map(normalizeSearchResult)
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
        .slice(0, limit);

      return { type: 'ok', results };
    } catch (error) {
      return {
        type: 'error',
        errorCode: 'unavailable',
        message: error instanceof Error ? error.message : 'Jina search failed.',
      };
    }
  };

  const fetchPage = async (request: WebSearchFetchPageRequest): Promise<WebSearchFetchPageResult> => {
    if (request.urls.length === 0) {
      return { type: 'ok', pages: [], failures: [] };
    }

    const outcomes = await Promise.all(request.urls.map(url => readOneUrl(httpFetch, apiKey, url, request.signal)));

    // Whole-batch transport / 5xx failure collapses into one envelope —
    // mirrors Microsoft Web IQ's policy. Per-URL 4xx stays granular so
    // a single bad target doesn't poison the rest of the batch.
    const allHardFail = outcomes.every(outcome => outcome.kind === 'fail' && (outcome.httpStatus === 0 || outcome.httpStatus >= 500));
    if (allHardFail) {
      const first = outcomes[0] as Extract<ReadOutcome, { kind: 'fail' }>;
      return { type: 'error', errorCode: 'unavailable', message: first.message };
    }

    const pages: Extract<WebSearchFetchPageResult, { type: 'ok' }>['pages'] = [];
    const failures: Extract<WebSearchFetchPageResult, { type: 'ok' }>['failures'] = [];

    for (const outcome of outcomes) {
      if (outcome.kind === 'ok') {
        const truncated = truncateUtf8(outcome.content, MAX_FETCH_PAGE_BYTES);
        pages.push({
          url: outcome.url,
          ...(outcome.title !== undefined ? { title: outcome.title } : {}),
          content: truncated.content,
          truncated: truncated.truncated,
          fullContentBytes: truncated.fullContentBytes,
        });
        continue;
      }

      failures.push({
        url: outcome.url,
        errorCode: httpStatusToErrorCode(outcome.httpStatus),
        message: outcome.message,
      });
    }

    return { type: 'ok', pages, failures };
  };

  return { search, fetchPage };
};
