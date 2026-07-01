import { shortId } from '../../../../../shared/short-id.ts';
import { normalizeDomainEntry, normalizeDomainList } from '../../../../tools/web-search/domain-normalize.ts';
import { fetchPageAndRecordUsage } from '../../../../tools/web-search/fetch-page.ts';
import { resolveConfiguredWebSearchProvider } from '../../../../tools/web-search/provider.ts';
import { loadSearchConfig } from '../../../../tools/web-search/search-config.ts';
import { searchWebAndRecordUsage } from '../../../../tools/web-search/search.ts';
import type { ConfiguredWebSearchProvider, WebSearchProvider, WebSearchProviderName } from '../../../../tools/web-search/types.ts';
import { truncatePreservingCodePoints } from '../../../shared/text.ts';
import { type ServerToolLoopState, type ServerToolOutputItem, type ServerToolRegistration } from '../server-tool-shim.ts';
import type { ResponsesFunctionTool, ResponsesFunctionToolCallItem, ResponsesHostedTool, ResponsesInputItem, ResponsesOutputWebSearchCall, ResponsesTool, ResponsesWebSearchAction, ResponsesWebSearchResult } from '@floway-dev/protocols/responses';
import { WEB_SEARCH_HOSTED_TYPE_NAMES } from '@floway-dev/protocols/responses';
import { providerModelOf } from '@floway-dev/provider';

// Runtime set derived from the canonical tuple declared next to
// `ResponsesHostedToolType` so the type union and runtime check can't drift.
//   https://github.com/openai/openai-python/blob/e75766769547601a25ed83b666c4d0fd046881f0/src/openai/types/responses/web_search_tool.py
//   https://github.com/openai/openai-python/blob/e75766769547601a25ed83b666c4d0fd046881f0/src/openai/types/responses/web_search_preview_tool.py
export const WEB_SEARCH_HOSTED_TYPES: ReadonlySet<string> = new Set<string>(WEB_SEARCH_HOSTED_TYPE_NAMES);

// Function-name regex `^[a-zA-Z0-9_-]+$` forbids dots, so the shim call
// uses the underscored form of the model's training-time `web.run`.
export const SHIM_TOOL_NAME = 'web_search';

interface ShimToolFilters {
  allowedDomains?: string[];
  blockedDomains?: string[];
  userLocation?: { city?: string; region?: string; country?: string; timezone?: string };
  maxResults?: number;
}

// Approximates the ~40 results native hosted web_search returns
// regardless of search_context_size; backends bill per call, so larger
// result sets only multiply upstream context-window cost. `medium` is
// the native default (matches openai-python `WebSearchTool.search_context_size`
// docstring: "Defaults to 'medium'") — when the client omits the field
// or sends an explicit `'medium'`, we still pass the corresponding
// maxResults so providers don't fall back to their own (smaller)
// default count.
const CONTEXT_SIZE_TO_MAX_RESULTS: Record<'low' | 'medium' | 'high', number> = {
  low: 10,
  medium: 20,
  high: 40,
};

const DEFAULT_SEARCH_CONTEXT_SIZE: keyof typeof CONTEXT_SIZE_TO_MAX_RESULTS = 'medium';

const isValidSearchContextSize = (v: unknown): v is keyof typeof CONTEXT_SIZE_TO_MAX_RESULTS =>
  typeof v === 'string' && v in CONTEXT_SIZE_TO_MAX_RESULTS;

// The hosted tool's `user_location` must surface to the model, not just
// to the backend provider — without this hint the model asks "Which
// city should I check?" even when the client supplied one.
const formatUserLocation = (loc: NonNullable<ShimToolFilters['userLocation']>): string => {
  const parts: string[] = [];
  if (loc.city) parts.push(loc.city);
  if (loc.region && loc.region !== loc.city) parts.push(loc.region);
  if (loc.country) parts.push(loc.country);
  const joined = parts.join(', ');
  if (!loc.timezone) return joined;
  return joined.length === 0 ? `(timezone: ${loc.timezone})` : `${joined} (timezone: ${loc.timezone})`;
};

// `web.run` shim call shape: 13 sub-properties on a single tool. The
// shim implements 3 (`search_query`, `open`, `find`); the other 10
// surface as per-entry error IRs at dispatch time. The description
// deliberately omits the unsupported ones.
//   https://github.com/openai/harmony/blob/abd677f7ac962629c808197caa1feb9e3e95d2b0/src/chat.rs#L259-L313
const buildShimFunctionTool = (
  canonical: ResponsesHostedTool,
  name: string,
): ResponsesFunctionTool => {
  const userLocation = canonical.user_location;
  const baseDescription
    = 'Accesses the web through three actions: searching, opening a page, and finding text inside a page. '
    + 'Multiple sub-property arrays may be populated in one call to dispatch several operations in parallel.';
  const hasUserLocation = userLocation !== undefined && (
    (userLocation.city !== undefined && userLocation.city.length > 0)
    || (userLocation.region !== undefined && userLocation.region.length > 0)
    || (userLocation.country !== undefined && userLocation.country.length > 0)
    || (userLocation.timezone !== undefined && userLocation.timezone.length > 0)
  );
  const description = hasUserLocation
    ? `${baseDescription} Default user location: ${formatUserLocation(userLocation)}. Use this as the default when the user asks about local information without specifying a location.`
    : baseDescription;

  return {
    type: 'function',
    name,
    description,
    parameters: {
      type: 'object',
      properties: {
        search_query: {
          type: 'array',
          description: 'Run one or more web searches. Each entry produces an independent search-results list.',
          items: {
            type: 'object',
            properties: {
              q: { type: 'string', description: 'The search query.' },
            },
            required: ['q'],
            additionalProperties: false,
          },
        },
        open: {
          type: 'array',
          description: 'Fetch the readable text content of fully qualified URLs.',
          items: {
            type: 'object',
            properties: {
              ref_id: { type: 'string', description: 'An HTTP or HTTPS URL.' },
            },
            required: ['ref_id'],
            additionalProperties: false,
          },
        },
        find: {
          type: 'array',
          description: 'Find exact case-insensitive matches of `pattern` inside the page at `ref_id`. Returns up to 10 matches with ~200 characters of surrounding context.',
          items: {
            type: 'object',
            properties: {
              ref_id: { type: 'string', description: 'An HTTP or HTTPS URL of the page to search inside.' },
              pattern: { type: 'string', description: 'Case-insensitive substring to find.' },
            },
            required: ['ref_id', 'pattern'],
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    // Strict mode requires `required` to list every property, but every
    // sub-property here is optional (one call may set only
    // `search_query`, another only `open`).
    strict: false,
  };
};

export const isHostedWebSearchTool = (tool: ResponsesTool): tool is ResponsesHostedTool =>
  typeof tool.type === 'string' && WEB_SEARCH_HOSTED_TYPES.has(tool.type);

// Canonical form of a hosted web_search tool: client's `type` alias is
// preserved (so round-trip fidelity holds), and the documented defaults
// for `search_context_size`, `search_content_types`, and
// `return_token_budget` are filled. `filters` and `user_location` pass
// through verbatim when present — never synthesized (the latter is
// IP-derived on real upstreams and we have no IP context to fake).
//
// References:
//   `search_context_size` default `'medium'` — openai-python
//   `WebSearchTool.search_context_size` docstring:
//     https://github.com/openai/openai-python/blob/main/src/openai/types/responses/web_search_tool.py
//   `return_token_budget` default `'default'` and
//   `search_content_types` default `['text']` — observed verbatim in
//   Copilot's `/responses` echo for `tools: [{type: 'web_search'}]`.
export const canonicalizeWebSearchTool = (raw: ResponsesTool): ResponsesHostedTool | undefined => {
  if (!isHostedWebSearchTool(raw)) return undefined;
  const canonical: ResponsesHostedTool = {
    type: raw.type,
    search_context_size: raw.search_context_size ?? DEFAULT_SEARCH_CONTEXT_SIZE,
    search_content_types: raw.search_content_types ?? ['text'],
    return_token_budget: raw.return_token_budget ?? 'default',
  };
  if (raw.filters !== undefined) canonical.filters = raw.filters;
  if (raw.user_location !== undefined) canonical.user_location = raw.user_location;
  return canonical;
};

const extractFilters = (tool: ResponsesHostedTool): ShimToolFilters => {
  const out: ShimToolFilters = {};
  if (tool.filters?.allowed_domains) out.allowedDomains = tool.filters.allowed_domains;
  if (tool.filters?.blocked_domains) out.blockedDomains = tool.filters.blocked_domains;
  if (tool.user_location) out.userLocation = tool.user_location;
  // Default to native's documented default (`medium`) when omitted.
  // Without this, a provider-side default (e.g. Tavily's smaller
  // baseline count) would silently shrink the result set on requests
  // that didn't think about search_context_size at all.
  const size = tool.search_context_size ?? DEFAULT_SEARCH_CONTEXT_SIZE;
  out.maxResults = CONTEXT_SIZE_TO_MAX_RESULTS[size as keyof typeof CONTEXT_SIZE_TO_MAX_RESULTS];
  return out;
};

interface PrepareToolsError {
  /** Human-readable error message. */
  message: string;
  /** JSON-Pointer-style location inside `tools[]`. */
  param: string;
}

type PrepareToolsResult =
  | { ok: true; filters: ShimToolFilters }
  | { ok: false; error: PrepareToolsError };

// Per-list cap matches the OpenAI documented "up to 100 allowed_domains
// or up to 100 blocked_domains" limit.
//   https://developers.openai.com/api/docs/guides/tools-web-search.md
const MAX_DOMAIN_LIST_ENTRIES = 100;

// Domain-list entry validator. First-failure-wins: returns at the
// first malformed entry so the 400 envelope names ONE offending
// value. We reject non-string entries with their type description
// (matches native's `invalid_type`-shaped rejection for non-string
// list entries); valid-string-but-bad-host entries reject with a
// simple message naming the value.
const validateDomainListEntry = (
  raw: unknown,
): { ok: true } | { ok: false; message: string } => {
  if (typeof raw !== 'string') {
    return { ok: false, message: `Expected string, got ${raw === null ? 'null' : typeof raw}.` };
  }
  if (raw.trim() === '' || /^https?:\/\//i.test(raw) || /[\s/?#@:]/.test(raw) || normalizeDomainEntry(raw) === null) {
    return { ok: false, message: `Invalid domain '${raw}'` };
  }
  return { ok: true };
};

// Validate the parts of a hosted-web-search entry the shim acts on.
// Anything else (`external_web_access`, `return_token_budget`, etc.)
// is silently dropped along with the hosted tool itself — the shim
// replaces the hosted entry with its shim function tool, so any
// hosted-only field the shim doesn't process never reaches upstream
// regardless.
const validateHostedEntry = (tool: ResponsesHostedTool): PrepareToolsError | null => {
  const sizeField = (tool as { search_context_size?: unknown }).search_context_size;
  if (sizeField !== undefined && sizeField !== null && !isValidSearchContextSize(sizeField)) {
    return {
      message: `web_search tool search_context_size must be one of ${Object.keys(CONTEXT_SIZE_TO_MAX_RESULTS).map(k => `'${k}'`).join(' | ')}; got ${JSON.stringify(sizeField)}.`,
      param: 'tools[].search_context_size',
    };
  }
  const filtersField = (tool as { filters?: unknown }).filters;
  if (filtersField === undefined || filtersField === null) return null;
  if (typeof filtersField !== 'object' || Array.isArray(filtersField)) {
    return {
      message: `web_search tool filters must be an object; got ${Array.isArray(filtersField) ? 'array' : typeof filtersField}.`,
      param: 'tools',
    };
  }
  for (const field of ['allowed_domains', 'blocked_domains'] as const) {
    const value = (filtersField as Record<string, unknown>)[field];
    // `undefined` and `null` both read as "omit" — same no-op
    // semantics as an empty list.
    if (value === undefined || value === null) continue;
    if (!Array.isArray(value)) {
      return {
        message: `web_search tool filters.${field} must be an array of strings; got ${typeof value}.`,
        param: 'tools',
      };
    }
    if (value.length > MAX_DOMAIN_LIST_ENTRIES) {
      return {
        message: `web_search tool filters.${field} accepts at most ${MAX_DOMAIN_LIST_ENTRIES} entries; got ${value.length}.`,
        param: 'tools',
      };
    }
    for (const entry of value) {
      const verdict = validateDomainListEntry(entry);
      if (!verdict.ok) {
        return { message: verdict.message, param: 'tools' };
      }
    }
  }
  return null;
};

// First hosted block's filters win, matching the framework's
// dedupe-to-first rule for hosted entries. Validation still runs
// across every hosted entry so a malformed later block rejects the
// request rather than slipping through behind the chosen first one.
// Name-collision resolution and the hosted-tool → function-tool
// replacement are the framework's responsibility.
export const prepareToolsForShim = (
  tools: ResponsesTool[],
): PrepareToolsResult => {
  let firstHostedFilters: ShimToolFilters = {};
  let captured = false;
  for (const tool of tools) {
    if (isHostedWebSearchTool(tool)) {
      const reject = validateHostedEntry(tool);
      if (reject !== null) return { ok: false, error: reject };
      if (!captured) {
        firstHostedFilters = extractFilters(tool);
        captured = true;
      }
    }
  }
  return { ok: true, filters: firstHostedFilters };
};

// ── Shim call parsing ──
// Types describe one logical operation parsed out of a shim call
// function_call. 13 documented sub-properties total in the gpt-5.x
// `web.run` shape; the shim implements 3 (search/open/find) and surfaces
// the other 10 as `unsupported` ops. `parseShimOperations` below
// produces a flat list in source order.

export type ShimOperationErrorKind = 'invalid-ref' | 'missing-arg';

export type ShimLogicalOperation =
  | {
    kind: 'search';
    /** Original index inside the shim's `search_query` array. */
    arrayIndex: number;
    query: string;
    /** When set, dispatch returns this verbatim instead of hitting the backend. */
    error?: string;
    errorKind?: ShimOperationErrorKind;
  }
  | {
    kind: 'open';
    arrayIndex: number;
    error?: string;
    errorKind?: ShimOperationErrorKind;
    url: string;
  }
  | {
    kind: 'find';
    arrayIndex: number;
    error?: string;
    errorKind?: ShimOperationErrorKind;
    url: string;
    pattern: string;
  }
  | {
    kind: 'unsupported';
    /** The shim call sub-property name the model populated (e.g. `click`). */
    subProperty: string;
    /** Original index inside that sub-property's array. */
    arrayIndex: number;
  }
  | {
    kind: 'wrong-type';
    subProperty: 'search_query' | 'open' | 'find';
    actualType: string;
  };

export type ParsedShimCall = { kind: 'ops'; ops: ShimLogicalOperation[] } | { kind: 'malformed' };

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

// Cap on the wire-item dump inlined into the malformed-input branch's
// `function_call_output` placeholder. A pathological prior wsc echo
// (deeply nested, multi-kilobyte) shouldn't get to blow the upstream
// context window through the diagnostic that explains it.
const MAX_MALFORMED_WIRE_DUMP_CHARS = 1024;

const stringField = (entry: unknown, key: string): string => {
  if (entry === null || typeof entry !== 'object') return '';
  const value = (entry as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
};

const describeJsonType = (v: unknown): string => v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;

export const parseShimOperations = (args: Record<string, unknown> | null): ParsedShimCall => {
  if (args === null) return { kind: 'malformed' };
  const ops: ShimLogicalOperation[] = [];

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

  // Top-level keys outside the shim call surface as unsupported ops.
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

  return {
    kind: 'ops',
    ops,
  };
};

const ITERATION_CAP = 30;

// One web_search backend op's result data: the action shape downstream
// references and the result list the renderer formats. Thin DTO — the
// wsc id and `status: 'completed'` live on the dispatcher's slot, not
// in here.
interface WebSearchCallIR {
  action: ResponsesWebSearchAction;
  results: ResponsesWebSearchResult[];
}

/**
 * Persistent `payload.private` shape for one `web_search_call`. One shim call
 * function_call corresponds to exactly one wsc and one op — multi-op
 * shim calls (multi-kind mix or multi-instance same-kind) are rejected at
 * dispatch with an `ambiguous` error, so there is never an array to
 * denormalize. The persisted-payload key IS the wsc id, so we don't repeat
 * it inside.
 *
 * - `functionCallItem` is the upstream's literal function_call from the
 *   originating turn, with `arguments` replaced by the
 *   jsonrepair-canonical strict-JSON form (every other field — type,
 *   call_id, name, status — passes through untouched). Replayed verbatim
 *   so the upstream model's prior assistant turn looks bit-exact.
 *
 * - `ir` is the in-flight `(action, results)` tuple straight from
 *   `planShimSlots`. Stored as data so the rendering format can
 *   evolve without re-persisting; reused by the renderer at replay time.
 *   Composition (rather than inlining `action` / `results` here) keeps
 *   any future IR field automatically reaching the persisted shape.
 *
 * Version-tagged: an unknown `v` falls through the no-payload branch in
 * `transformInputItemsForWebSearch` (action re-serialized into the
 * shim call shape, output replaced with the not-preserved notice). Starts
 * at 1; bump only on a wire-incompatible change after release.
 */
export interface WebSearchCallPrivatePayload {
  v: 1;
  functionCallItem: ResponsesFunctionToolCallItem;
  ir: WebSearchCallIR;
}

const isWebSearchCallPrivatePayload = (value: unknown): value is WebSearchCallPrivatePayload => {
  if (value === null || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  if (obj.v !== 1) return false;
  const fc = obj.functionCallItem;
  if (fc === null || typeof fc !== 'object') return false;
  const fcObj = fc as Record<string, unknown>;
  if (fcObj.type !== 'function_call' || typeof fcObj.call_id !== 'string' || typeof fcObj.name !== 'string' || typeof fcObj.arguments !== 'string') return false;
  const ir = obj.ir;
  if (ir === null || typeof ir !== 'object') return false;
  const irObj = ir as Record<string, unknown>;
  return irObj.action !== undefined && Array.isArray(irObj.results);
};

export const synthesizeWebSearchCallId = (): string => shortId('ws_gw');

// Distinct id namespace (cc_replay_*) from synthesized wsc ids (ws_gw_*)
// so a replay call_id never reads as a wsc id in logs.
const synthesizeReplayCallId = (): string => shortId('cc_replay');

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
    // Native gates `sources` on `include:
    // ["web_search_call.action.sources"]`; only include when the
    // client opted in. The producer (dispatch.ts) decides whether to
    // pass the list based on the include token.
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

// No native action.type fits shim-only error classes (unknown
// sub-property, malformed args); encode them via action.type:'search'
// with the diagnostic in queries[0] so wire-typed SDKs still parse the
// item.
const schemaErrorIr = (
  queryLabel: string,
  title: string,
  snippet: string,
): WebSearchCallIR => ({
  // Emit both `query` and `queries`; see `actionSearchQueries`.
  action: { type: 'search', query: queryLabel, queries: [queryLabel] },
  results: [{
    type: 'text_result',
    url: '',
    title,
    snippet,
  }],
});

// Error-text phrasings closely follow OpenAI's gpt-oss reference
// simple_browser tool so gpt-oss-family models (trained on those exact
// phrasings) recognize the structure; non-OpenAI models read them as
// plain natural-language tool output.
//
// References (pinned to commit 285b05d for stable line numbers):
// - gpt-oss simple_browser_tool.py `find` no-match phrase, line 246:
//   https://github.com/openai/gpt-oss/blob/285b05d96dea9ce7da52ecbbe86791f18239c510/gpt_oss/tools/simple_browser/simple_browser_tool.py#L246
// - gpt-oss simple_browser_tool.py `BackendError` fetching phrase, lines 444-445:
//   https://github.com/openai/gpt-oss/blob/285b05d96dea9ce7da52ecbbe86791f18239c510/gpt_oss/tools/simple_browser/simple_browser_tool.py#L444-L445
// - litellm `Search failed: <e>` idiom:
//   https://github.com/BerriAI/litellm/blob/main/litellm/integrations/websearch_interception/transformation.py
const searchFailedText = (providerMessage: string): string =>
  `Search failed: ${providerMessage}`;

const openFailedText = (url: string, providerMessage: string): string =>
  `Error fetching URL \`${url}\`: ${providerMessage}`;

// openai-python `ActionSearch.query` is a single string; some clients
// send only `queries[]`. Accept both: the shim emits both fields on
// every search action so typed SDKs reading either one keep working.
const actionSearchQueries = (action: Extract<ResponsesWebSearchAction, { type: 'search' }>): string[] => {
  if (action.queries !== undefined) return action.queries;
  if (action.query !== undefined) return [action.query];
  return [];
};

// Re-serializes a wire `action` back into the shim's JSON arguments
// shape (`{search_query:[{q}]}` / `{open:[{ref_id}]}` /
// `{find:[{ref_id,pattern}]}`). Used only on the replay-fallback path to
// fill the paired function_call's `arguments` when no private payload
// exists; the happy path replays the upstream's original args verbatim.
const actionToShimCallArgsJson = (action: ResponsesWebSearchAction): string => {
  switch (action.type) {
  case 'search':
    return JSON.stringify({
      search_query: actionSearchQueries(action).map(q => ({ q })),
    });
  case 'open_page':
    // Echoed open_page items can arrive without `url` (native drops it
    // on soft failure); fall back to an empty string in the replayed
    // args so the upstream sees a well-formed `ref_id` field rather
    // than a literal `undefined` collapse.
    return JSON.stringify({ open: [{ ref_id: action.url ?? '' }] });
  case 'find_in_page':
    return JSON.stringify({ find: [{ ref_id: action.url, pattern: action.pattern }] });
  }
};

// Numeric `[N]` references in the snippet body let the model cite
// specific search hits in its final answer. Empty results emit
// `(no results)` rather than a bare header so the model recognizes the
// call ran successfully but returned nothing.
const formatSearchResultsText = (query: string, results: readonly ResponsesWebSearchResult[]): string => {
  const header = `Search results for "${query}":`;
  if (results.length === 0) return `${header}\n\n(no results)`;
  const sections = results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`);
  return `${header}\n\n${sections.join('\n\n')}`;
};

const renderOpOutputText = (action: ResponsesWebSearchAction, results: ResponsesWebSearchResult[]): string => {
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

// Replay preprocessor: turns echoed `web_search_call` items back into the
// (function_call, function_call_output) pair the upstream model originally
// saw on turn 1.
//
// Two paths:
//
// 1. Private payload hit (the request resolved the wsc id to a persisted
//    `payload.private`): emit the upstream's literal `functionCallItem`
//    (jsonrepair-canonical args, original call_id) plus a
//    `function_call_output` whose body is rendered from the persisted
//    `output.action / output.results` via `renderOpOutputText`. This is
//    the bit-exact round-trip.
//
// 2. No payload (`store: false`, expired, foreign id, cross-account, or
//    schema-version mismatch): degrade to a synthesized pair whose
//    `function_call.arguments` is the wire action re-serialized into
//    the shim call shape (so the model still sees what it asked for) and
//    whose `function_call_output` text is the not-preserved placeholder.
//    The shim deliberately does not read `item.results` from the
//    wire — turn 1's wire results may or may not exist depending on the
//    client's `include` opt-in, and trusting them across the wire would
//    couple state correctness to client storage discipline.
//
// Echoed items with no `action` at all surface as a placeholder
// `function_call + function_call_output` pair that inlines the raw wire
// item so the model can see what the client actually sent.
export const transformInputItemsForWebSearch = (
  input: ResponsesInputItem[],
  toolName: string,
  getPrivatePayload?: (id: string) => unknown,
): ResponsesInputItem[] => {
  const out: ResponsesInputItem[] = [];

  for (const item of input) {
    if (item.type !== 'web_search_call') {
      out.push(item);
      continue;
    }

    const candidatePayload = item.id !== undefined ? getPrivatePayload?.(item.id) : undefined;
    if (isWebSearchCallPrivatePayload(candidatePayload)) {
      out.push(
        candidatePayload.functionCallItem,
        {
          type: 'function_call_output',
          call_id: candidatePayload.functionCallItem.call_id,
          output: renderOpOutputText(candidatePayload.ir.action, candidatePayload.ir.results),
        },
      );
      continue;
    }

    if (item.action === undefined) {
      const callId = synthesizeReplayCallId();
      // Truncate the wire dump so a deeply-nested or large prior item
      // doesn't blow the upstream context window via a multi-kilobyte
      // function_call_output. The model still sees enough to recognize
      // the malformed shape.
      const wireDump = truncatePreservingCodePoints(JSON.stringify(item), MAX_MALFORMED_WIRE_DUMP_CHARS);
      out.push(
        {
          type: 'function_call',
          call_id: callId,
          name: toolName,
          arguments: '{}',
          status: 'completed',
        },
        {
          type: 'function_call_output',
          call_id: callId,
          output: `A prior web_search_call item in the conversation history was malformed (no \`action\` field). Original wire item: ${wireDump}`,
        },
      );
      continue;
    }

    const callId = synthesizeReplayCallId();
    out.push(
      {
        type: 'function_call',
        call_id: callId,
        name: toolName,
        arguments: actionToShimCallArgsJson(item.action),
        status: 'completed',
      },
      {
        type: 'function_call_output',
        call_id: callId,
        // See path 2 in the function docstring above for why the wire
        // `item.results` is ignored.
        output: 'Prior search results were not preserved in the conversation history. Call web_search again if you need them.',
      },
    );
  }
  return out;
};

interface PageCacheEntry {
  content: string;
  truncated: boolean;
  fullContentBytes: number;
  title?: string;
}

interface ShimState {
  filters: ShimToolFilters;
  // Per-request cache shared across `open` and `find` so a find op can
  // reuse a body the model already opened without a second fetch.
  pageCache: Map<string, PageCacheEntry>;
  // Memoized lazy resolver. The first backend dispatch pays the
  // load+resolve cost; later dispatches reuse the cached result.
  // Replay-only paths (echoed `web_search_call` input with no hosted
  // tool emission) never call this, so an unconfigured search provider
  // does not 500 the request.
  getProvider: () => Promise<ConfiguredWebSearchProvider>;
  apiKeyId: string;
  // Set when the client passed `include: ["web_search_call.results"]` on
  // the request. Native Responses gates the `results` field on this
  // include token; the shim follows suit on the wire item — but the IR
  // (and therefore `payload.private`) always carries the real results
  // so a subsequent turn echoing the item id can be hydrated regardless.
  includeSearchResults: boolean;
  // Set when the client passed
  // `include: ["web_search_call.action.sources"]` on the request,
  // mirroring native Responses' opt-in shape for the search-action
  // sources list. Native gates the field on this include token; the
  // shim follows suit so the wire shape matches.
  includeSearchActionSources: boolean;
  // Aborted when the downstream client disconnects. Threaded through
  // every backend provider call so a cancelled request stops
  // generating upstream load instead of running to completion.
  downstreamAbortSignal?: AbortSignal;
}

type FetchAndCacheResult =
  | { ok: true; cached: PageCacheEntry }
  | { ok: false; output: string };

// Suffix-match per Tavily and Microsoft Grounding search-side filter
// semantics: `example.com` matches `example.com`, `www.example.com`,
// and `sub.example.com`, but NOT `evil-example.com`.
const matchesAnyDomain = (hostname: string, domains: readonly string[]): boolean => {
  for (const d of domains) {
    if (hostname === d) return true;
    if (hostname.endsWith(`.${d}`)) return true;
  }
  return false;
};

export const isUrlAllowed = (url: string, filter: ShimToolFilters): boolean => {
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

// Literal case-insensitive substring matcher with context windows;
// mirrors gpt-oss `find` rendering minus the cursor-numbered output.
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

const errorSnippet = (title: string, snippet: string): ResponsesWebSearchResult => ({
  type: 'text_result',
  url: '',
  title,
  snippet,
});

// Resolve the configured backend or return an `unavailable` reason.
// Disabled / missing-credential is per-op visible: each backend
// dispatch synthesizes a snippet IR so the model sees the error
// in-band instead of the whole request 5xx'ing.
const resolveActiveProvider = async (
  state: ShimState,
): Promise<{ provider: WebSearchProvider; providerName: WebSearchProviderName } | { unavailable: string }> => {
  const configured = await state.getProvider();
  if (configured.type === 'enabled') {
    return { provider: configured.impl, providerName: configured.provider };
  }
  if (configured.type === 'disabled') {
    return { unavailable: 'Web search provider is not configured on this gateway.' };
  }
  return { unavailable: `Web search provider ${configured.provider} is missing its credential on this gateway.` };
};

const runBackendSearch = async (
  op: Extract<ShimLogicalOperation, { kind: 'search' }>,
  state: ShimState,
): Promise<WebSearchCallIR> => {
  if (op.error !== undefined) {
    const title = op.errorKind === 'missing-arg' ? 'Missing argument' : 'Invalid ref_id';
    return searchIr(op.query, [errorSnippet(title, op.error)]);
  }
  const active = await resolveActiveProvider(state);
  if ('unavailable' in active) {
    return searchIr(op.query, [errorSnippet('Search error', searchFailedText(active.unavailable))]);
  }
  const { results, sources } = await runOneSearchQuery(op.query, state, active);
  return searchIr(op.query, results, sources);
};

// Collapses N `search_query` entries into one wsc: same-action protocol
// shape (`{type:'search', queries:[...]}`) with the merged result set
// (concatenated in entry order). Per-query failures interleave as error
// snippets so the model sees which queries succeeded.
const runBackendSearchMulti = async (
  ops: Array<Extract<ShimLogicalOperation, { kind: 'search' }>>,
  state: ShimState,
): Promise<WebSearchCallIR> => {
  const queries = ops.map(op => op.query);
  const active = await resolveActiveProvider(state);
  if ('unavailable' in active) {
    return searchIrFromQueries(queries, [errorSnippet('Search error', searchFailedText(active.unavailable))]);
  }
  const perQuery = await Promise.all(ops.map(op => runOneSearchQuery(op.query, state, active)));
  const mergedResults = perQuery.flatMap(r => r.results);
  const mergedSources = state.includeSearchActionSources
    ? perQuery.flatMap(r => r.sources ?? [])
    : undefined;
  return searchIrFromQueries(queries, mergedResults, mergedSources);
};

interface SearchQueryOutcome {
  results: ResponsesWebSearchResult[];
  sources?: { type: 'url'; url: string }[];
}

const runOneSearchQuery = async (
  query: string,
  state: ShimState,
  active: { provider: WebSearchProvider; providerName: WebSearchProviderName },
): Promise<SearchQueryOutcome> => {
  try {
    const searchRequest = {
      query,
      maxResults: state.filters.maxResults,
      allowedDomains: state.filters.allowedDomains,
      blockedDomains: state.filters.blockedDomains,
      userLocation: state.filters.userLocation,
      ...(state.downstreamAbortSignal !== undefined ? { signal: state.downstreamAbortSignal } : {}),
    };
    const result = await searchWebAndRecordUsage({
      provider: active.provider,
      providerName: active.providerName,
      keyId: state.apiKeyId,
      request: searchRequest,
    });

    if (result.type === 'error') {
      const msg = result.message ?? result.errorCode;
      return { results: [errorSnippet('Search error', searchFailedText(msg))] };
    }

    // Per-snippet char cap on web_search_call.results[].snippet. Providers
    // like Tavily can return multi-KB snippets per hit; without this cap a
    // single noisy query can blow the upstream context window. Independent
    // of the provider-enforced 10 KiB cap on open_page bodies.
    const results: ResponsesWebSearchResult[] = result.results.map(r => ({
      type: 'text_result' as const,
      url: r.source,
      title: r.title,
      snippet: truncateString(r.content.map(c => c.text).join('\n'), 2_048),
    }));
    // Native gates `action.sources` on `include:
    // ["web_search_call.action.sources"]`; build the list only when
    // the client opted in. The shape mirrors openai-python
    // `ActionSearch.sources[]` (`{type:'url', url}`).
    const sources = state.includeSearchActionSources
      ? result.results.map(r => ({ type: 'url' as const, url: r.source }))
      : undefined;
    return sources !== undefined ? { results, sources } : { results };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { results: [errorSnippet('Search error', searchFailedText(msg))] };
  }
};

const runBatchFetch = async (
  needFetch: string[],
  state: ShimState,
): Promise<Map<string, FetchAndCacheResult>> => {
  const perUrl = new Map<string, FetchAndCacheResult>();
  const active = await resolveActiveProvider(state);
  if ('unavailable' in active) {
    for (const url of needFetch) {
      perUrl.set(url, { ok: false, output: openFailedText(url, active.unavailable) });
    }
    return perUrl;
  }
  try {
    const fetchRequest = {
      urls: needFetch,
      ...(state.downstreamAbortSignal !== undefined ? { signal: state.downstreamAbortSignal } : {}),
    };
    const result = await fetchPageAndRecordUsage({
      provider: active.provider,
      providerName: active.providerName,
      keyId: state.apiKeyId,
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
        // URL silently dropped by the provider — surface as explicit
        // error so the model doesn't see a phantom empty page.
        perUrl.set(url, { ok: false, output: openFailedText(url, 'No page returned') });
        continue;
      }
      const entry: PageCacheEntry = {
        content: page.content,
        truncated: page.truncated,
        fullContentBytes: page.fullContentBytes,
        title: page.title,
      };
      state.pageCache.set(url, entry);
      perUrl.set(url, { ok: true, cached: entry });
    }
    return perUrl;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    for (const url of needFetch) {
      perUrl.set(url, { ok: false, output: openFailedText(url, msg) });
    }
    return perUrl;
  }
};

// Intra-call batching: collect every URL the shim's
// open[]/find[] sub-arrays reference, dedup, hit cache, and issue
// one batched provider.fetchPage for the remainder. Cross-call
// joining is deliberately NOT done — same-turn serial execution
// means later shim calls can simply read the populated cache.
const fetchAndCacheManyPages = async (
  urls: string[],
  state: ShimState,
): Promise<Map<string, FetchAndCacheResult>> => {
  const results = new Map<string, FetchAndCacheResult>();
  const needFetch: string[] = [];
  const seen = new Set<string>();

  for (const url of urls) {
    if (seen.has(url)) continue;
    seen.add(url);
    const cached = state.pageCache.get(url);
    if (cached) {
      results.set(url, { ok: true, cached });
      continue;
    }
    needFetch.push(url);
  }

  if (needFetch.length > 0) {
    const perUrl = await runBatchFetch(needFetch, state);
    for (const url of needFetch) {
      results.set(url, perUrl.get(url)!);
    }
  }
  return results;
};

const openPageSuccessIr = (url: string, cached: PageCacheEntry): WebSearchCallIR => {
  // Provider truncates to its 10 KiB per-page cap. Truncated bodies get
  // a sentinel so the model can choose to `find` for specific content.
  const body = cached.content
    + (cached.truncated
      ? `\n\n[Content truncated; full page is ${cached.fullContentBytes} bytes. Use web_search's \`find\` sub-property with a pattern to locate specific content.]`
      : '');
  return openPageIr(url, [{
    type: 'text_result',
    url,
    title: cached.title ?? '',
    snippet: body,
  }]);
};

const runBackendOpenPage = async (
  op: Extract<ShimLogicalOperation, { kind: 'open' }>,
  batchPromise: Promise<Map<string, FetchAndCacheResult>>,
): Promise<WebSearchCallIR> => {
  const url = op.url;

  // Invalid-ref-id (`op.error !== undefined`) carries a
  // `{type:'search', queries:[ref_id]}` via `searchIr` because a urlless
  // open_page action would be meaningless.
  if (op.error !== undefined) {
    const title = op.errorKind === 'missing-arg' ? 'Missing argument' : 'Invalid ref_id';
    return searchIr(op.url, [errorSnippet(title, op.error)]);
  }

  // Batch fetch pre-populates entries for every URL the parser produced
  // (blocked URLs get an explicit failure entry), so the lookup is total.
  const fetched = (await batchPromise).get(url)!;
  if (!fetched.ok) {
    return openPageIr(url, [errorSnippet('Open page error', fetched.output)]);
  }
  return openPageSuccessIr(url, fetched.cached);
};

const runBackendFind = async (
  op: Extract<ShimLogicalOperation, { kind: 'find' }>,
  batchPromise: Promise<Map<string, FetchAndCacheResult>>,
): Promise<WebSearchCallIR> => {
  const url = op.url;
  const pattern = op.pattern;

  if (op.error !== undefined) {
    const title = op.errorKind === 'missing-arg' ? 'Missing argument' : 'Invalid ref_id';
    return findInPageIr(url, pattern, [errorSnippet(title, op.error)]);
  }

  // Pre-fetch failures keep the `find_in_page` action carrying the
  // original url + pattern; switching to `open_page` would silently
  // change `action.type` mid-result.
  const fetched = (await batchPromise).get(url)!;
  if (!fetched.ok) {
    return findInPageIr(url, pattern, [errorSnippet('Find error', fetched.output)]);
  }

  // Mirror gpt-oss `find` defaults.
  const matches = findMatches(fetched.cached.content, pattern, {
    maxMatches: 10,
    contextChars: 200,
  });
  // Native find_in_page returns one result whose snippet either lists
  // the matches or says "No matching ...".
  const title = matches.length === 0 ? 'No match' : 'Matches';
  return findInPageIr(url, pattern, [{
    type: 'text_result',
    url,
    title,
    snippet: formatMatches(pattern, url, matches),
  }]);
};

const executeOperation = (
  op: ShimLogicalOperation,
  state: ShimState,
  batchPromise: Promise<Map<string, FetchAndCacheResult>>,
): Promise<WebSearchCallIR> => {
  switch (op.kind) {
  case 'search':
    return runBackendSearch(op, state);
  case 'open':
    return runBackendOpenPage(op, batchPromise);
  case 'find':
    return runBackendFind(op, batchPromise);
  case 'unsupported':
    return Promise.resolve(schemaErrorIr(
      `unsupported action: ${op.subProperty}[${op.arrayIndex}]`,
      'Unsupported action',
      `Error: the \`${op.subProperty}\` sub-property is not supported by this gateway. Only \`search_query\`, \`open\`, and \`find\` are available.`,
    ));
  case 'wrong-type':
    return Promise.resolve(schemaErrorIr(
      `wrong-type sub-property: ${op.subProperty}`,
      'Malformed sub-property',
      `Error: the \`${op.subProperty}\` sub-property must be an array of objects; got ${op.actualType}.`,
    ));
  }
};

// Collect the open/find URL set for THIS shim call and kick off one
// provider.fetchPage covering all of them. `fetchAndCacheManyPages`
// installs per-URL inflight slots synchronously so later shim calls in
// the same turn dedup against this batch.
//
// Blocked URLs (failing `isUrlAllowed`) are filtered OUT of the batch
// fetch but populated into the result map with an explicit
// `{ ok: false, output: 'Error fetching URL <url>: Blocked by tool
// filters' }` entry (the `Blocked by tool filters` string runs
// through `openFailedText` for consistency with real fetch failures).
// That way the per-op handlers (`runBackendOpenPage` /
// `runBackendFind`) can trust the gate's verdict by reading the map
// directly instead of re-running `isUrlAllowed` themselves.
const startBatchFetchForShimCall = async (
  parsed: ParsedShimCall,
  state: ShimState,
): Promise<Map<string, FetchAndCacheResult>> => {
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
    if (!isUrlAllowed(url, state.filters)) {
      blockedUrls.push(url);
      continue;
    }
    batchUrls.push(url);
  }
  const fetched = await fetchAndCacheManyPages(batchUrls, state);
  for (const url of blockedUrls) {
    fetched.set(url, { ok: false, output: openFailedText(url, 'Blocked by tool filters') });
  }
  return fetched;
};

const planShimSlots = (
  parsed: ParsedShimCall,
  toolName: string,
  state: ShimState,
  loopState: ServerToolLoopState,
): { id: string; promise: Promise<WebSearchCallIR> } => {
  if (loopState.iterationCount > ITERATION_CAP) {
    return {
      id: synthesizeWebSearchCallId(),
      promise: Promise.resolve(schemaErrorIr(
        'tool budget exhausted',
        'Tool call budget exhausted',
        `Web search iteration limit (${ITERATION_CAP}) reached. Further web_search calls in this response will return this same error. Summarize what you have already learned, and continue the task using other available tools (shell, file inspection, prior knowledge) or directly answer based on what you've gathered.`,
      )),
    };
  }

  if (parsed.kind === 'malformed' || parsed.ops.length === 0) {
    return {
      id: synthesizeWebSearchCallId(),
      promise: Promise.resolve(schemaErrorIr(
        'malformed shim call arguments',
        'Malformed arguments',
        'Error: arguments must be a JSON object with sub-property arrays (search_query[], open[], find[]).',
      )),
    };
  }

  // Multi-`search_query` entries collapse into one wsc with a multi-query
  // action (`{type:'search', queries:[...]}`) — protocol-native and the
  // only same-kind shape that fits in one wsc. Require every entry to
  // parse cleanly; one malformed entry forces the model to fix all of
  // them rather than silently dropping a search.
  if (parsed.ops.length > 1 && parsed.ops.every(op => op.kind === 'search' && op.error === undefined)) {
    const searchOps = parsed.ops as Array<Extract<ShimLogicalOperation, { kind: 'search' }>>;
    return {
      id: synthesizeWebSearchCallId(),
      promise: runBackendSearchMulti(searchOps, state),
    };
  }

  // Any other multi-op shape cannot reduce to a single wsc action: `open`
  // and `find` actions each carry one url/pattern, and mixed kinds have
  // incompatible action types. Surface as ambiguous and let the model
  // split into independent calls.
  if (parsed.ops.length > 1) {
    return {
      id: synthesizeWebSearchCallId(),
      promise: Promise.resolve(schemaErrorIr(
        'ambiguous shim call',
        'Ambiguous tool call',
        `Error: ambiguous \`${toolName}\` tool call — each function_call maps to one web_search_call. `
        + 'Multiple `search_query` entries are fine (they collapse into one search). '
        + 'For `open`/`find`, or any mix of kinds, split into one call per `open[]` entry, `find[]` entry, or `search_query[]` batch.',
      )),
    };
  }

  const batchPromise = startBatchFetchForShimCall(parsed, state);
  return {
    id: synthesizeWebSearchCallId(),
    promise: executeOperation(parsed.ops[0], state, batchPromise),
  };
};

export const webSearchServerTool: ServerToolRegistration = (invocation, gatewayCtx) => {
  if (invocation.targetApi === 'responses' && !providerModelOf(invocation.candidate).enabledFlags.has('responses-web-search-shim')) {
    return { type: 'inactive' };
  }

  const tools = Array.isArray(invocation.payload.tools) ? invocation.payload.tools : [];
  const hasHostedWebSearch = tools.some(isHostedWebSearchTool);
  const hasReplayInput = invocation.payload.input.some(i => i.type === 'web_search_call');
  if (!hasHostedWebSearch && !hasReplayInput) return { type: 'inactive' };

  const prepared = prepareToolsForShim(tools);
  if (!prepared.ok) {
    return {
      type: 'invalid-request',
      message: prepared.error.message,
      param: prepared.error.param,
    };
  }

  const { filters } = prepared;
  const includeArray = Array.isArray(invocation.payload.include) ? invocation.payload.include : [];
  let configuredProvider: Promise<ConfiguredWebSearchProvider> | undefined;
  const state: ShimState = {
    filters,
    pageCache: new Map(),
    getProvider: () => {
      configuredProvider ??= loadSearchConfig().then(cfg => resolveConfiguredWebSearchProvider(cfg));
      return configuredProvider;
    },
    apiKeyId: gatewayCtx.apiKeyId,
    includeSearchResults: includeArray.includes('web_search_call.results'),
    includeSearchActionSources: includeArray.includes('web_search_call.action.sources'),
    ...(gatewayCtx.abortSignal !== undefined ? { downstreamAbortSignal: gatewayCtx.abortSignal } : {}),
  };

  return {
    type: 'active',
    baseToolName: SHIM_TOOL_NAME,
    transformItems: (items, toolName) => transformInputItemsForWebSearch(items, toolName, id => gatewayCtx.store.getPrivatePayload(id)),
    ...(hasHostedWebSearch
      ? {
          hosted: {
            hostedTypes: WEB_SEARCH_HOSTED_TYPE_NAMES,
            canonicalize: canonicalizeWebSearchTool,
            buildFunctionTool: buildShimFunctionTool,
            dispatcher: ({ intercepted, loopState }) => {
              const slot = planShimSlots(parseShimOperations(intercepted.arguments), intercepted.name, state, loopState);
              const functionCallItem: ResponsesFunctionToolCallItem = {
                type: 'function_call',
                call_id: intercepted.callId,
                name: intercepted.name,
                // Serialize the post-jsonrepair parsed object rather than
                // re-using the upstream's raw `arguments` string (which
                // might be malformed); `{}` is the safe fallback when
                // jsonrepair couldn't even produce an object.
                arguments: JSON.stringify(intercepted.arguments ?? {}),
                status: 'completed',
              };
              return [{
                id: slot.id,
                startItem: { type: 'web_search_call', status: 'in_progress' },
                startEvents: [
                  { type: 'response.web_search_call.in_progress' },
                  { type: 'response.web_search_call.searching' },
                ],
                run: async function* run() {
                  const ir = await slot.promise;
                  // `results` is gated on the client's `include`
                  // opt-in to match native Responses' default wire
                  // shape; the IR keeps them either way for the
                  // private-payload round-trip.
                  const item: ServerToolOutputItem & Omit<ResponsesOutputWebSearchCall, 'id'> = state.includeSearchResults
                    ? { type: 'web_search_call', status: 'completed', action: ir.action, results: ir.results }
                    : { type: 'web_search_call', status: 'completed', action: ir.action };
                  const privatePayload: WebSearchCallPrivatePayload = {
                    v: 1,
                    functionCallItem,
                    ir,
                  };
                  return {
                    item,
                    endEvents: [{ type: 'response.web_search_call.completed' }],
                    privatePayload,
                  };
                },
              }];
            },
          },
        }
      : {}),
  };
};
