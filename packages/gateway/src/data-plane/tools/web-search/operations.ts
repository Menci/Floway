// Shared parser, local-provider executor, and Responses web-search IR.
// Responses always uses the parser and IR; its local mode also executes and
// renders operations here, while alpha passthrough delegates the commands and
// retains the upstream model-facing output. The Codex compatibility route uses
// this engine only in its default local-provider mode.

import { normalizeDomainList } from './domain-normalize.ts';
import { fetchPageAndRecordUsage } from './fetch-page.ts';
import { searchWebAndRecordUsage } from './search.ts';
import type { ConfiguredWebSearchProvider, WebSearchProvider, WebSearchProviderName } from './types.ts';
import { truncatePreservingCodePoints } from '../../chat/shared/text.ts';
import type { ResponsesWebSearchAction, ResponsesWebSearchResult } from '@floway-dev/protocols/responses';
import { isAbortError } from '@floway-dev/provider';

// Search-context-size → result-count mapping. Approximates the ~40 results
// native hosted web_search returns regardless of search_context_size;
// backends bill per call, so larger result sets only multiply upstream
// context-window cost. `medium` is the native default (matches openai-python
// `WebSearchTool.search_context_size` docstring: "Defaults to 'medium'").
//   https://github.com/openai/openai-python/blob/f16fbbd2bd25dc1ff150b5f78dbd15ff6bab6d91/src/openai/types/responses/web_search_tool.py#L65-L70
export const CONTEXT_SIZE_TO_MAX_RESULTS: Record<'low' | 'medium' | 'high', number> = {
  low: 10,
  medium: 20,
  high: 40,
};

export const DEFAULT_SEARCH_CONTEXT_SIZE: keyof typeof CONTEXT_SIZE_TO_MAX_RESULTS = 'medium';

const SEARCH_CONTEXT_SIZES = new Set<keyof typeof CONTEXT_SIZE_TO_MAX_RESULTS>(['low', 'medium', 'high']);

export const isSearchContextSize = (v: unknown): v is keyof typeof CONTEXT_SIZE_TO_MAX_RESULTS =>
  typeof v === 'string' && SEARCH_CONTEXT_SIZES.has(v as keyof typeof CONTEXT_SIZE_TO_MAX_RESULTS);

// Default to native's documented default (`medium`) when omitted. Without
// this, a provider-side default (e.g. Tavily's smaller baseline count) would
// silently shrink the result set on requests that didn't set the field.
export const maxResultsForContextSize = (size: keyof typeof CONTEXT_SIZE_TO_MAX_RESULTS | undefined): number =>
  CONTEXT_SIZE_TO_MAX_RESULTS[size ?? DEFAULT_SEARCH_CONTEXT_SIZE];

// Per-snippet char cap on a search result's rendered text. Providers like
// Tavily can return multi-KB snippets per hit; without this cap a single
// noisy query can blow the upstream context window. Independent of the
// provider-enforced 10 KiB cap on open_page bodies.
const MAX_SEARCH_SNIPPET_CHARS = 2_048;

export interface WebSearchFilters {
  allowedDomains?: string[];
  blockedDomains?: string[];
  userLocation?: { city?: string; region?: string; country?: string; timezone?: string };
  maxResults?: number;
}

// ── Command parsing ──
// One logical operation parsed out of a `{ search_query, open, find, … }`
// command object. The three implemented kinds (`search`, `open`, `find`)
// carry the backend inputs; every other populated key surfaces as an
// `unsupported` op, and a sub-property whose value isn't an array surfaces
// as `wrong-type`. `parseWebSearchOperations` produces a flat list in source
// order (search → open → find → the rest).

export type WebSearchOperationErrorKind = 'invalid-ref' | 'missing-arg';

export type WebSearchOperation =
  | {
    kind: 'search';
    /** Original index inside the `search_query` array. */
    arrayIndex: number;
    query: string;
    /** When set, dispatch returns this verbatim instead of hitting the backend. */
    error?: string;
    errorKind?: WebSearchOperationErrorKind;
  }
  | {
    kind: 'open';
    arrayIndex: number;
    error?: string;
    errorKind?: WebSearchOperationErrorKind;
    url: string;
  }
  | {
    kind: 'find';
    arrayIndex: number;
    error?: string;
    errorKind?: WebSearchOperationErrorKind;
    url: string;
    pattern: string;
  }
  | {
    kind: 'unsupported';
    /** The command key the caller populated (e.g. `click`). */
    subProperty: string;
    /** Original index inside that key's array. */
    arrayIndex: number;
  }
  | {
    kind: 'wrong-type';
    subProperty: 'search_query' | 'open' | 'find';
    actualType: string;
  };

export type ParsedWebSearchOperations = { kind: 'ops'; ops: WebSearchOperation[] } | { kind: 'malformed' };

// Stricter than `/^https?:\/\//i`: that regex accepts `https://` (empty
// host). Reject malformed refs at parse time so dispatch always sees a
// well-formed URL.
const isUrl = (s: string): boolean => {
  let parsed: URL;
  try {
    parsed = new URL(s);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.hostname === '') return false;
  return true;
};

const refIdError = (refId: string): string =>
  `Error: ref_id must be a fully-qualified URL in the gateway shim (got '${refId}'). The gateway shim does not preserve prior-call ids across turns.`;

const missingArgError = (field: string): string =>
  `Error: missing required argument "${field}".`;

const SUPPORTED_KEYS: ReadonlySet<string> = new Set(['search_query', 'open', 'find']);

const stringField = (entry: unknown, key: string): string => {
  if (entry === null || typeof entry !== 'object') return '';
  const value = (entry as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
};

const describeJsonType = (v: unknown): string => v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;

export const parseWebSearchOperations = (args: Record<string, unknown> | null): ParsedWebSearchOperations => {
  if (args === null) return { kind: 'malformed' };
  const ops: WebSearchOperation[] = [];

  const searchQuery = args.search_query;
  if (searchQuery !== undefined) {
    if (!Array.isArray(searchQuery)) {
      ops.push({ kind: 'wrong-type', subProperty: 'search_query', actualType: describeJsonType(searchQuery) });
    } else {
      for (let i = 0; i < searchQuery.length; i++) {
        const q = stringField(searchQuery[i], 'q');
        if (q === '') {
          ops.push({ kind: 'search', arrayIndex: i, query: '', error: missingArgError('q'), errorKind: 'missing-arg' });
          continue;
        }
        ops.push({ kind: 'search', arrayIndex: i, query: q });
      }
    }
  }

  const open = args.open;
  if (open !== undefined) {
    if (!Array.isArray(open)) {
      ops.push({ kind: 'wrong-type', subProperty: 'open', actualType: describeJsonType(open) });
    } else {
      for (let i = 0; i < open.length; i++) {
        const refId = stringField(open[i], 'ref_id');
        if (refId === '') {
          ops.push({ kind: 'open', arrayIndex: i, url: '', error: missingArgError('ref_id'), errorKind: 'missing-arg' });
          continue;
        }
        if (!isUrl(refId)) {
          ops.push({ kind: 'open', arrayIndex: i, url: refId, error: refIdError(refId), errorKind: 'invalid-ref' });
          continue;
        }
        ops.push({ kind: 'open', arrayIndex: i, url: refId });
      }
    }
  }

  const find = args.find;
  if (find !== undefined) {
    if (!Array.isArray(find)) {
      ops.push({ kind: 'wrong-type', subProperty: 'find', actualType: describeJsonType(find) });
    } else {
      for (let i = 0; i < find.length; i++) {
        const refId = stringField(find[i], 'ref_id');
        const pattern = stringField(find[i], 'pattern');
        if (refId === '') {
          ops.push({ kind: 'find', arrayIndex: i, url: '', pattern, error: missingArgError('ref_id'), errorKind: 'missing-arg' });
          continue;
        }
        if (!isUrl(refId)) {
          ops.push({ kind: 'find', arrayIndex: i, url: refId, pattern, error: refIdError(refId), errorKind: 'invalid-ref' });
          continue;
        }
        if (pattern === '') {
          ops.push({ kind: 'find', arrayIndex: i, url: refId, pattern: '', error: missingArgError('pattern'), errorKind: 'missing-arg' });
          continue;
        }
        ops.push({ kind: 'find', arrayIndex: i, url: refId, pattern });
      }
    }
  }

  // Keys outside the implemented set surface as unsupported ops.
  for (const key of Object.keys(args)) {
    if (SUPPORTED_KEYS.has(key)) continue;
    const value = args[key];
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        ops.push({ kind: 'unsupported', subProperty: key, arrayIndex: i });
      }
    } else {
      ops.push({ kind: 'unsupported', subProperty: key, arrayIndex: 0 });
    }
  }

  return { kind: 'ops', ops };
};

// ── Execution session ──

interface PageCacheEntry {
  content: string;
  truncated: boolean;
  fullContentBytes: number;
  title?: string;
}

// The provider binding + filters + accounting context every operation runs
// against. `pageCache` is shared across `open` and `find` so a find op can
// reuse a body a prior open already fetched without a second round-trip.
export interface WebSearchExecutionSession {
  // Memoized lazy resolver. The first backend dispatch pays the
  // load+resolve cost; later dispatches reuse the cached result. Replay-only
  // paths (Responses shim echoing prior items with no live op) never call
  // this, so an unconfigured search provider does not 500 the request.
  getProvider: () => Promise<ConfiguredWebSearchProvider>;
  filters: WebSearchFilters;
  apiKeyId: string;
  pageCache: Map<string, PageCacheEntry>;
  // Whether to populate `action.sources` on search IRs. Native Responses
  // gates the field on `include: ["web_search_call.action.sources"]`; the
  // Codex path leaves it off (its output is plain text).
  includeSearchActionSources: boolean;
  // Aborted when the downstream client disconnects. Threaded into every
  // backend provider call so a cancelled request stops generating upstream
  // load instead of running to completion.
  signal?: AbortSignal;
}

// ── IR construction ──

// One backend op's result data: the action shape downstream references and
// the result list the renderer formats. Thin DTO — any wire id and status
// live on the caller's slot, not in here.
export interface WebSearchCallIR {
  action: ResponsesWebSearchAction;
  results: ResponsesWebSearchResult[];
  outputText?: string;
}

const searchIr = (
  query: string,
  results: ResponsesWebSearchResult[],
  sources?: { type: 'url'; url: string }[],
): WebSearchCallIR => searchIrFromQueries([query], results, sources);

// Builds a single wsc for one or more search queries. Multi-query actions
// are protocol-native (`{type:'search', queries:[...]}`); the singular
// `query` field is emitted alongside for SDKs that only know the legacy
// single-string shape — see `actionSearchQueries`.
const searchIrFromQueries = (
  queries: string[],
  results: ResponsesWebSearchResult[],
  sources?: { type: 'url'; url: string }[],
): WebSearchCallIR => ({
  action: {
    type: 'search',
    query: queries.join(' | '),
    queries,
    ...(sources !== undefined ? { sources } : {}),
  },
  results,
});

const openPageIr = (
  url: string | undefined,
  results: ResponsesWebSearchResult[],
): WebSearchCallIR => ({
  // Omit `url` when undefined to match native's soft-failure shape;
  // never emit `url: ''`.
  action: url !== undefined && url.length > 0
    ? { type: 'open_page', url }
    : { type: 'open_page' },
  results,
});

const findInPageIr = (
  url: string,
  pattern: string,
  results: ResponsesWebSearchResult[],
): WebSearchCallIR => ({
  action: { type: 'find_in_page', url, pattern },
  results,
});

// No native action.type fits the shim-only error classes (unknown
// sub-property, malformed args); encode them via action.type:'search' with
// the diagnostic in queries[0] so wire-typed SDKs still parse the item.
export const schemaErrorIr = (
  queryLabel: string,
  title: string,
  snippet: string,
): WebSearchCallIR => ({
  action: { type: 'search', query: queryLabel, queries: [queryLabel] },
  results: [{ type: 'text_result', url: '', title, snippet }],
});

// ── Error / not-supported text ──
// Phrasings closely follow OpenAI's gpt-oss reference simple_browser tool so
// gpt-oss-family models (trained on those exact phrasings) recognize the
// structure; non-OpenAI models read them as plain natural-language output.
//
// References (pinned to commit 285b05d for stable line numbers):
// - gpt-oss simple_browser_tool.py `find` no-match phrase, line 246:
//   https://github.com/openai/gpt-oss/blob/285b05d96dea9ce7da52ecbbe86791f18239c510/gpt_oss/tools/simple_browser/simple_browser_tool.py#L246
// - gpt-oss simple_browser_tool.py `BackendError` fetching phrase, lines 444-445:
//   https://github.com/openai/gpt-oss/blob/285b05d96dea9ce7da52ecbbe86791f18239c510/gpt_oss/tools/simple_browser/simple_browser_tool.py#L444-L445
// - litellm `Search failed: <e>` idiom:
//   https://github.com/BerriAI/litellm/blob/6a797f97b22d74cc5603ddacb16e38bf4a259858/litellm/integrations/websearch_interception/handler.py#L180-L186
const searchFailedText = (providerMessage: string): string =>
  `Search failed: ${providerMessage}`;

const openFailedText = (url: string, providerMessage: string): string =>
  `Error fetching URL \`${url}\`: ${providerMessage}`;

const unsupportedOperationText = (subProperty: string): string =>
  `Error: the \`${subProperty}\` sub-property is not supported by this gateway. Only \`search_query\`, \`open\`, and \`find\` are available.`;

const wrongTypeOperationText = (subProperty: string, actualType: string): string =>
  `Error: the \`${subProperty}\` sub-property must be an array of objects; got ${actualType}.`;

const errorSnippet = (title: string, snippet: string): ResponsesWebSearchResult => ({
  type: 'text_result',
  url: '',
  title,
  snippet,
});

// ── Text rendering ──

// openai-python `ActionSearch.query` is a single string; some clients send
// only `queries[]`. Accept both: the engine emits both fields on every
// search action so typed SDKs reading either one keep working.
export const actionSearchQueries = (action: Extract<ResponsesWebSearchAction, { type: 'search' }>): string[] => {
  if (action.queries !== undefined) return action.queries;
  if (action.query !== undefined) return [action.query];
  return [];
};

// Numeric `[N]` references in the snippet body let the model cite specific
// search hits in its final answer. Empty results emit `(no results)` rather
// than a bare header so the model recognizes the call ran successfully but
// returned nothing.
const formatSearchResultsText = (query: string, results: readonly ResponsesWebSearchResult[]): string => {
  const header = `Search results for "${query}":`;
  if (results.length === 0) return `${header}\n\n(no results)`;
  const sections = results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`);
  return `${header}\n\n${sections.join('\n\n')}`;
};

const renderOperationOutputText = (action: ResponsesWebSearchAction, results: ResponsesWebSearchResult[]): string => {
  switch (action.type) {
  case 'search': {
    const queryLabel = actionSearchQueries(action).join(' | ');
    return formatSearchResultsText(queryLabel, results);
  }
  case 'open_page': {
    if (results.length === 0) {
      const url = action.url ?? '(no url)';
      return `Open ${url}: (no body returned)`;
    }
    return results[0].snippet;
  }
  case 'find_in_page':
    return results.length > 0 ? results[0].snippet : '';
  }
};

export const renderWebSearchCallOutput = (ir: WebSearchCallIR): string =>
  ir.outputText ?? renderOperationOutputText(ir.action, ir.results);

// ── Domain filtering ──

// Suffix-match per Tavily and Microsoft Grounding search-side filter
// semantics: `example.com` matches `example.com`, `www.example.com`, and
// `sub.example.com`, but NOT `evil-example.com`.
const matchesAnyDomain = (hostname: string, domains: readonly string[]): boolean => {
  for (const d of domains) {
    if (hostname === d) return true;
    if (hostname.endsWith(`.${d}`)) return true;
  }
  return false;
};

export const isUrlAllowed = (url: string, filter: WebSearchFilters): boolean => {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return false;
  }
  const blocked = normalizeDomainList(filter.blockedDomains);
  if (blocked.length > 0 && matchesAnyDomain(hostname, blocked)) {
    return false;
  }
  const allowed = normalizeDomainList(filter.allowedDomains);
  if (allowed.length > 0 && !matchesAnyDomain(hostname, allowed)) {
    return false;
  }
  return true;
};

// ── find (literal case-insensitive substring matcher) ──
// Mirrors gpt-oss `find` rendering minus the cursor-numbered output.
//   https://github.com/openai/gpt-oss/blob/285b05d96dea9ce7da52ecbbe86791f18239c510/gpt_oss/tools/simple_browser/simple_browser_tool.py

interface FindMatch {
  before: string;
  matched: string;
  after: string;
}

export const findMatches = (
  text: string,
  pattern: string,
  opts: { maxMatches: number; contextChars: number },
): FindMatch[] => {
  if (pattern.length === 0) return [];
  const lowerText = text.toLowerCase();
  const lowerPat = pattern.toLowerCase();
  const matches: FindMatch[] = [];
  let from = 0;
  while (matches.length < opts.maxMatches) {
    const idx = lowerText.indexOf(lowerPat, from);
    if (idx < 0) break;
    const beforeStart = Math.max(0, idx - opts.contextChars);
    const afterEnd = Math.min(text.length, idx + lowerPat.length + opts.contextChars);
    matches.push({
      before: text.slice(beforeStart, idx),
      matched: text.slice(idx, idx + lowerPat.length),
      after: text.slice(idx + lowerPat.length, afterEnd),
    });
    from = idx + lowerPat.length;
  }
  return matches;
};

export const formatMatches = (pattern: string, url: string, matches: readonly FindMatch[]): string => {
  if (matches.length === 0) return `No matching \`${pattern}\` found on ${url}.`;
  const noun = matches.length === 1 ? 'match' : 'matches';
  const lines: string[] = [`${matches.length} ${noun} for pattern: \`${pattern}\``, ''];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    lines.push(`Match ${i + 1}:`);
    lines.push(`"...${m.before}[${m.matched}]${m.after}..."`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
};

const truncateString = (s: string, maxChars: number): string =>
  s.length <= maxChars ? s : `${truncatePreservingCodePoints(s, maxChars)}…`;

// ── Provider resolution ──

// Resolve the configured backend or return an `unavailable` reason.
// Disabled / missing-credential is per-op visible: each backend dispatch
// synthesizes a snippet IR so the model sees the error in-band instead of
// the whole request 5xx'ing.
const resolveActiveProvider = async (
  session: WebSearchExecutionSession,
): Promise<{ provider: WebSearchProvider; providerName: WebSearchProviderName } | { unavailable: string }> => {
  const configured = await session.getProvider();
  if (configured.type === 'enabled') {
    return { provider: configured.impl, providerName: configured.provider };
  }
  if (configured.type === 'disabled') {
    return { unavailable: 'Web search provider is not configured on this gateway.' };
  }
  return { unavailable: `Web search provider ${configured.provider} is missing its credential on this gateway.` };
};

// ── search ──

interface SearchQueryOutcome {
  results: ResponsesWebSearchResult[];
  sources?: { type: 'url'; url: string }[];
}

const runOneSearchQuery = async (
  query: string,
  session: WebSearchExecutionSession,
  active: { provider: WebSearchProvider; providerName: WebSearchProviderName },
): Promise<SearchQueryOutcome> => {
  try {
    const searchRequest = {
      query,
      maxResults: session.filters.maxResults,
      allowedDomains: session.filters.allowedDomains,
      blockedDomains: session.filters.blockedDomains,
      userLocation: session.filters.userLocation,
      ...(session.signal !== undefined ? { signal: session.signal } : {}),
    };
    const result = await searchWebAndRecordUsage({
      provider: active.provider,
      providerName: active.providerName,
      keyId: session.apiKeyId,
      request: searchRequest,
    });

    if (result.type === 'error') {
      const msg = result.message ?? result.errorCode;
      return { results: [errorSnippet('Search error', searchFailedText(msg))] };
    }

    const results: ResponsesWebSearchResult[] = result.results.map(r => ({
      type: 'text_result' as const,
      url: r.source,
      title: r.title,
      snippet: truncateString(r.content.map(c => c.text).join('\n'), MAX_SEARCH_SNIPPET_CHARS),
    }));
    // Native gates `action.sources` on `include:
    // ["web_search_call.action.sources"]`; build the list only when the
    // caller opted in. The shape mirrors openai-python `ActionSearch.sources[]`
    // (`{type:'url', url}`).
    const sources = session.includeSearchActionSources
      ? result.results.map(r => ({ type: 'url' as const, url: r.source }))
      : undefined;
    return sources !== undefined ? { results, sources } : { results };
  } catch (e) {
    if (isAbortError(e)) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    return { results: [errorSnippet('Search error', searchFailedText(msg))] };
  }
};

const runBackendSearch = async (
  op: Extract<WebSearchOperation, { kind: 'search' }>,
  session: WebSearchExecutionSession,
): Promise<WebSearchCallIR> => {
  if (op.error !== undefined) {
    const title = op.errorKind === 'missing-arg' ? 'Missing argument' : 'Invalid ref_id';
    return searchIr(op.query, [errorSnippet(title, op.error)]);
  }
  const active = await resolveActiveProvider(session);
  if ('unavailable' in active) {
    return searchIr(op.query, [errorSnippet('Search error', searchFailedText(active.unavailable))]);
  }
  const { results, sources } = await runOneSearchQuery(op.query, session, active);
  return searchIr(op.query, results, sources);
};

// Collapses N `search_query` entries into one wsc: same-action protocol
// shape (`{type:'search', queries:[...]}`) with the merged result set
// (concatenated in entry order). Per-query failures interleave as error
// snippets so the model sees which queries succeeded.
export const runBackendSearchMulti = async (
  ops: Array<Extract<WebSearchOperation, { kind: 'search' }>>,
  session: WebSearchExecutionSession,
): Promise<WebSearchCallIR> => {
  const queries = ops.map(op => op.query);
  const active = await resolveActiveProvider(session);
  if ('unavailable' in active) {
    return searchIrFromQueries(queries, [errorSnippet('Search error', searchFailedText(active.unavailable))]);
  }
  const perQuery = await Promise.all(ops.map(op => runOneSearchQuery(op.query, session, active)));
  const mergedResults = perQuery.flatMap(r => r.results);
  const mergedSources = session.includeSearchActionSources
    ? perQuery.flatMap(r => r.sources ?? [])
    : undefined;
  return searchIrFromQueries(queries, mergedResults, mergedSources);
};

// ── open / find (page fetch + cache) ──

type FetchAndCacheResult =
  | { ok: true; cached: PageCacheEntry }
  | { ok: false; output: string };

export type WebSearchPageFetchMap = Map<string, FetchAndCacheResult>;

const runBatchFetch = async (
  needFetch: string[],
  session: WebSearchExecutionSession,
): Promise<WebSearchPageFetchMap> => {
  const perUrl: WebSearchPageFetchMap = new Map();
  const active = await resolveActiveProvider(session);
  if ('unavailable' in active) {
    for (const url of needFetch) {
      perUrl.set(url, { ok: false, output: openFailedText(url, active.unavailable) });
    }
    return perUrl;
  }
  try {
    const fetchRequest = {
      urls: needFetch,
      ...(session.signal !== undefined ? { signal: session.signal } : {}),
    };
    const result = await fetchPageAndRecordUsage({
      provider: active.provider,
      providerName: active.providerName,
      keyId: session.apiKeyId,
      request: fetchRequest,
    });

    if (result.type === 'error') {
      const msg = result.message ?? result.errorCode;
      for (const url of needFetch) {
        perUrl.set(url, { ok: false, output: openFailedText(url, msg) });
      }
      return perUrl;
    }

    const failureByUrl = new Map(result.failures.map(f => [f.url, f]));
    const pageByUrl = new Map(result.pages.map(p => [p.url, p]));
    for (const url of needFetch) {
      const failure = failureByUrl.get(url);
      if (failure) {
        perUrl.set(url, { ok: false, output: openFailedText(url, failure.message ?? failure.errorCode) });
        continue;
      }
      const page = pageByUrl.get(url);
      if (!page) {
        // URL silently dropped by the provider — surface as explicit error
        // so the model doesn't see a phantom empty page.
        perUrl.set(url, { ok: false, output: openFailedText(url, 'No page returned') });
        continue;
      }
      const entry: PageCacheEntry = {
        content: page.content,
        truncated: page.truncated,
        fullContentBytes: page.fullContentBytes,
        title: page.title,
      };
      session.pageCache.set(url, entry);
      perUrl.set(url, { ok: true, cached: entry });
    }
    return perUrl;
  } catch (e) {
    if (isAbortError(e)) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    for (const url of needFetch) {
      perUrl.set(url, { ok: false, output: openFailedText(url, msg) });
    }
    return perUrl;
  }
};

// Intra-call batching: collect every URL the open[]/find[] sub-arrays
// reference, dedup, hit cache, and issue one batched provider.fetchPage for
// the remainder. Cross-call joining is deliberately NOT done — same-turn
// serial execution means later calls can simply read the populated cache.
const fetchAndCacheManyPages = async (
  urls: string[],
  session: WebSearchExecutionSession,
): Promise<WebSearchPageFetchMap> => {
  const results: WebSearchPageFetchMap = new Map();
  const needFetch: string[] = [];
  const seen = new Set<string>();

  for (const url of urls) {
    if (seen.has(url)) continue;
    seen.add(url);
    const cached = session.pageCache.get(url);
    if (cached) {
      results.set(url, { ok: true, cached });
      continue;
    }
    needFetch.push(url);
  }

  if (needFetch.length > 0) {
    const perUrl = await runBatchFetch(needFetch, session);
    for (const url of needFetch) {
      results.set(url, perUrl.get(url)!);
    }
  }
  return results;
};

// Collect the open/find URL set for a parsed command and kick off one
// provider.fetchPage covering all of them.
//
// Blocked URLs (failing `isUrlAllowed`) are filtered OUT of the batch fetch
// but populated into the result map with an explicit `{ ok: false, output:
// 'Error fetching URL <url>: Blocked by tool filters' }` entry. That way the
// per-op handlers can trust the gate's verdict by reading the map directly
// instead of re-running `isUrlAllowed` themselves.
export const startBatchFetch = async (
  parsed: ParsedWebSearchOperations,
  session: WebSearchExecutionSession,
): Promise<WebSearchPageFetchMap> => {
  if (parsed.kind !== 'ops') return new Map();
  const batchUrls: string[] = [];
  const blockedUrls: string[] = [];
  const seen = new Set<string>();
  for (const op of parsed.ops) {
    if (op.kind !== 'open' && op.kind !== 'find') continue;
    if (op.error !== undefined) continue;
    const url = op.url;
    if (url === '') continue;
    if (seen.has(url)) continue;
    seen.add(url);
    if (!isUrlAllowed(url, session.filters)) {
      blockedUrls.push(url);
      continue;
    }
    batchUrls.push(url);
  }
  const fetched = await fetchAndCacheManyPages(batchUrls, session);
  for (const url of blockedUrls) {
    fetched.set(url, { ok: false, output: openFailedText(url, 'Blocked by tool filters') });
  }
  return fetched;
};

const openPageSuccessIr = (url: string, cached: PageCacheEntry): WebSearchCallIR => {
  // Provider truncates to its 10 KiB per-page cap. Truncated bodies get a
  // sentinel so the model can choose to `find` for specific content.
  const body = cached.content
    + (cached.truncated
      ? `\n\n[Content truncated; full page is ${cached.fullContentBytes} bytes. Use the \`find\` sub-property with a pattern to locate specific content.]`
      : '');
  return openPageIr(url, [{
    type: 'text_result',
    url,
    title: cached.title ?? '',
    snippet: body,
  }]);
};

const runBackendOpenPage = async (
  op: Extract<WebSearchOperation, { kind: 'open' }>,
  batch: WebSearchPageFetchMap,
): Promise<WebSearchCallIR> => {
  const url = op.url;

  // Invalid-ref-id (`op.error !== undefined`) carries a `{type:'search',
  // queries:[ref_id]}` via `searchIr` because a urlless open_page action
  // would be meaningless.
  if (op.error !== undefined) {
    const title = op.errorKind === 'missing-arg' ? 'Missing argument' : 'Invalid ref_id';
    return searchIr(op.url, [errorSnippet(title, op.error)]);
  }

  // Batch fetch pre-populates entries for every URL the parser produced
  // (blocked URLs get an explicit failure entry), so the lookup is total.
  const fetched = batch.get(url)!;
  if (!fetched.ok) {
    return openPageIr(url, [errorSnippet('Open page error', fetched.output)]);
  }
  return openPageSuccessIr(url, fetched.cached);
};

const runBackendFind = async (
  op: Extract<WebSearchOperation, { kind: 'find' }>,
  batch: WebSearchPageFetchMap,
): Promise<WebSearchCallIR> => {
  const url = op.url;
  const pattern = op.pattern;

  if (op.error !== undefined) {
    const title = op.errorKind === 'missing-arg' ? 'Missing argument' : 'Invalid ref_id';
    return findInPageIr(url, pattern, [errorSnippet(title, op.error)]);
  }

  // Pre-fetch failures keep the `find_in_page` action carrying the original
  // url + pattern; switching to `open_page` would silently change
  // `action.type` mid-result.
  const fetched = batch.get(url)!;
  if (!fetched.ok) {
    return findInPageIr(url, pattern, [errorSnippet('Find error', fetched.output)]);
  }

  // Mirror gpt-oss `find` defaults.
  const matches = findMatches(fetched.cached.content, pattern, {
    maxMatches: 10,
    contextChars: 200,
  });
  const title = matches.length === 0 ? 'No match' : 'Matches';
  return findInPageIr(url, pattern, [{
    type: 'text_result',
    url,
    title,
    snippet: formatMatches(pattern, url, matches),
  }]);
};

// Execute one operation into its `web_search_call` IR. `search`/`open`/
// `find` hit the backend (open/find read the pre-issued batch map);
// `unsupported`/`wrong-type` encode a diagnostic search IR so a Responses
// wire item still parses.
export const executeOperationToIr = (
  op: WebSearchOperation,
  session: WebSearchExecutionSession,
  batch: WebSearchPageFetchMap,
): Promise<WebSearchCallIR> => {
  switch (op.kind) {
  case 'search':
    return runBackendSearch(op, session);
  case 'open':
    return runBackendOpenPage(op, batch);
  case 'find':
    return runBackendFind(op, batch);
  case 'unsupported':
    return Promise.resolve(schemaErrorIr(
      `unsupported action: ${op.subProperty}[${op.arrayIndex}]`,
      'Unsupported action',
      unsupportedOperationText(op.subProperty),
    ));
  case 'wrong-type':
    return Promise.resolve(schemaErrorIr(
      `wrong-type sub-property: ${op.subProperty}`,
      'Malformed sub-property',
      wrongTypeOperationText(op.subProperty, op.actualType),
    ));
  }
};

// Execute one operation and render its model-visible text directly. The
// Codex `/alpha/search` endpoint consumes only text, so `unsupported` /
// `wrong-type` render as their bare diagnostic rather than the IR-wrapped
// "Search results for …" form the Responses wire item needs.
export const executeOperationToText = async (
  op: WebSearchOperation,
  session: WebSearchExecutionSession,
  batch: WebSearchPageFetchMap,
): Promise<string> => {
  switch (op.kind) {
  case 'unsupported':
    return unsupportedOperationText(op.subProperty);
  case 'wrong-type':
    return wrongTypeOperationText(op.subProperty, op.actualType);
  default: {
    const ir = await executeOperationToIr(op, session, batch);
    return renderWebSearchCallOutput(ir);
  }
  }
};
