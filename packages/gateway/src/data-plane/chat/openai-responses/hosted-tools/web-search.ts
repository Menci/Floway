import { isEqual } from 'es-toolkit';

import { shortId } from '../../../../shared/short-id.ts';
import { alphaSearchOperation } from '../../../alpha-search/pipeline.ts';
import { truncatePreservingCodePoints } from '../../../shared/text.ts';
import { normalizeDomainEntry } from '../../../tools/web-search/domain-normalize.ts';
import {
  actionSearchQueries,
  assertLocalWebSearchSupport,
  CONTEXT_SIZE_TO_MAX_RESULTS,
  DEFAULT_SEARCH_CONTEXT_SIZE,
  isSearchContextSize,
  isSearchResponseLength,
  maxResultsForContextSize,
  parseWebSearchOperations,
  renderWebSearchCallOutput,
  schemaErrorIr,
  UNSUPPORTED_LOCAL_WEB_SEARCH_FEATURE_ERROR_NAME,
  UnsupportedLocalWebSearchFeatureError,
  unsupportedLocalWebSearchFeatureIr,
  type ParsedWebSearchOperations,
  type SearchResponseLength,
  type WebSearchCallIR,
  type WebSearchFilters,
  type WebSearchOperation,
} from '../../../tools/web-search/operations.ts';
import { localWebSearch } from '../../../tools/web-search/pipeline.ts';
import { discardHostedToolResponse, hostedToolRequest, isHostedScalarAbort, type HostedToolContext, type HostedToolFailure, type ServerToolHistoryExpansion, type ServerToolLoopState, type ServerToolOutputItem, type ServerToolRegistration } from '../hosted-tools.ts';
import type { Result } from '@floway-dev/pipeline';
import { isJsonObject, type JsonObject } from '@floway-dev/protocols/common';
import type { OpenAIResponsesFunctionTool, OpenAIResponsesWebSearchTool, OpenAIResponsesInputWebSearchCall, OpenAIResponsesOutputWebSearchCall, OpenAIResponsesTool, OpenAIResponsesWebSearchAction } from '@floway-dev/protocols/openai-responses';
import { collectOpenAIResponsesToolEntries, createRandomOpenAIResponsesItemId, WEB_SEARCH_HOSTED_TYPE_NAMES } from '@floway-dev/protocols/openai-responses';
import { parseJsonBody, type ProtocolError } from '@floway-dev/provider';

// Runtime set derived from the canonical tuple declared next to
// `OpenAIResponsesHostedToolType` so the type union and runtime check can't drift.
//   https://github.com/openai/openai-python/blob/e75766769547601a25ed83b666c4d0fd046881f0/src/openai/types/responses/web_search_tool.py
//   https://github.com/openai/openai-python/blob/e75766769547601a25ed83b666c4d0fd046881f0/src/openai/types/responses/web_search_preview_tool.py
export const WEB_SEARCH_HOSTED_TYPES: ReadonlySet<string> = new Set<string>(WEB_SEARCH_HOSTED_TYPE_NAMES);

// Function-name regex `^[a-zA-Z0-9_-]+$` forbids dots, so the shim call
// uses the underscored form of the model's training-time `web.run`.
export const SHIM_TOOL_NAME = 'web_search';

// Put the selected hosted declaration's `user_location` in the replacement
// function description so the model can use it as the default for local searches.
const formatUserLocation = (loc: NonNullable<OpenAIResponsesWebSearchTool['user_location']>): string => {
  const parts: string[] = [];
  if (loc.city) parts.push(loc.city);
  if (loc.region && loc.region !== loc.city) parts.push(loc.region);
  if (loc.country) parts.push(loc.country);
  const joined = parts.join(', ');
  if (!loc.timezone) return joined;
  return joined.length === 0 ? `(timezone: ${loc.timezone})` : `${joined} (timezone: ${loc.timezone})`;
};

// The injected function mirrors the complete command object accepted by
// OpenAI's alpha-search endpoint. Alpha passthrough can execute every field;
// local Tavily, Jina, and Microsoft Web IQ execution rejects the fields it
// cannot implement before dispatch.
// https://github.com/openai/codex/blob/2f19a57704fb7b1db032bc38cf995034254eaebb/codex-rs/codex-api/src/search.rs#L31-L213
export const buildShimFunctionTool = (
  canonical: OpenAIResponsesWebSearchTool,
  name: string,
): OpenAIResponsesFunctionTool => {
  const userLocation = canonical.user_location;
  const baseDescription
    = 'Accesses OpenAI web search through text and image search, page navigation, screenshots, finance, weather, sports, and time operations. '
    + 'Multiple sub-property arrays may be populated in one call to dispatch several operations in parallel.';
  const hasUserLocation = userLocation != null
    && [userLocation.city, userLocation.region, userLocation.country, userLocation.timezone].some(field => field != null && field.length > 0);
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
              recency: { type: 'integer', minimum: 0, description: 'Limit results to this many recent days.' },
              domains: { type: 'array', items: { type: 'string' }, description: 'Limit results to these domains.' },
            },
            required: ['q'],
            additionalProperties: false,
          },
        },
        image_query: {
          type: 'array',
          description: 'Run one or more image searches.',
          items: {
            type: 'object',
            properties: {
              q: { type: 'string', description: 'The image search query.' },
              recency: { type: 'integer', minimum: 0, description: 'Limit results to this many recent days.' },
              domains: { type: 'array', items: { type: 'string' }, description: 'Limit results to these domains.' },
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
              ref_id: { type: 'string', description: 'A result reference id or HTTP(S) URL.' },
              lineno: { type: 'integer', minimum: 0, description: 'Line number at which to position the page.' },
            },
            required: ['ref_id'],
            additionalProperties: false,
          },
        },
        click: {
          type: 'array',
          description: 'Open numbered links from previously opened pages.',
          items: {
            type: 'object',
            properties: {
              ref_id: { type: 'string', description: 'Reference id of the page containing the link.' },
              id: { type: 'integer', minimum: 0, description: 'Numbered link id.' },
            },
            required: ['ref_id', 'id'],
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
        screenshot: {
          type: 'array',
          description: 'Take screenshots of PDF pages.',
          items: {
            type: 'object',
            properties: {
              ref_id: { type: 'string', description: 'Reference id or URL of the PDF.' },
              pageno: { type: 'integer', minimum: 0, description: 'Zero-indexed PDF page number.' },
            },
            required: ['ref_id', 'pageno'],
            additionalProperties: false,
          },
        },
        finance: {
          type: 'array',
          description: 'Look up market prices for financial assets.',
          items: {
            type: 'object',
            properties: {
              ticker: { type: 'string', description: 'Ticker symbol.' },
              type: { type: 'string', enum: ['equity', 'fund', 'crypto', 'index'], description: 'Asset type.' },
              market: { type: 'string', description: 'ISO 3166-1 alpha-3 country code, OTC, or an empty string for cryptocurrency.' },
            },
            required: ['ticker', 'type'],
            additionalProperties: false,
          },
        },
        weather: {
          type: 'array',
          description: 'Look up weather forecasts.',
          items: {
            type: 'object',
            properties: {
              location: { type: 'string', description: 'Location in Country, Area, City format.' },
              start: { type: 'string', description: 'Start date in YYYY-MM-DD format.' },
              duration: { type: 'integer', minimum: 0, description: 'Number of forecast days.' },
            },
            required: ['location'],
            additionalProperties: false,
          },
        },
        sports: {
          type: 'array',
          description: 'Look up sports schedules and standings.',
          items: {
            type: 'object',
            properties: {
              tool: { type: 'string', enum: ['sports'] },
              fn: { type: 'string', enum: ['schedule', 'standings'] },
              league: { type: 'string', enum: ['nba', 'wnba', 'nfl', 'nhl', 'mlb', 'epl', 'ncaamb', 'ncaawb', 'ipl'] },
              team: { type: 'string' },
              opponent: { type: 'string' },
              date_from: { type: 'string', description: 'Start date in YYYY-MM-DD format.' },
              date_to: { type: 'string', description: 'End date in YYYY-MM-DD format.' },
              num_games: { type: 'integer', minimum: 0 },
              locale: { type: 'string' },
            },
            required: ['fn', 'league'],
            additionalProperties: false,
          },
        },
        time: {
          type: 'array',
          description: 'Get the time at one or more UTC offsets.',
          items: {
            type: 'object',
            properties: {
              utc_offset: { type: 'string', description: 'UTC offset formatted like +03:00.' },
            },
            required: ['utc_offset'],
            additionalProperties: false,
          },
        },
        response_length: {
          type: 'string',
          enum: ['short', 'medium', 'long'],
          description: 'Requested search response length.',
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

export const isHostedWebSearchTool = (tool: OpenAIResponsesTool): tool is OpenAIResponsesWebSearchTool =>
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
export const recognizeWebSearchTool = (raw: OpenAIResponsesTool): OpenAIResponsesWebSearchTool | undefined => {
  if (!isHostedWebSearchTool(raw)) return undefined;
  const canonical: OpenAIResponsesWebSearchTool = {
    ...raw,
    type: raw.type,
    search_context_size: raw.search_context_size ?? DEFAULT_SEARCH_CONTEXT_SIZE,
    search_content_types: raw.search_content_types ?? ['text'],
    return_token_budget: raw.return_token_budget ?? 'default',
  };
  return canonical;
};

const ALPHA_SEARCH_SETTING_KEYS = [
  'user_location',
  'search_context_size',
  'filters',
  'image_settings',
  'allowed_callers',
  'external_web_access',
] as const satisfies readonly (keyof OpenAIResponsesWebSearchTool)[];

export const alphaSearchSettingsFromHosted = (
  hosted: OpenAIResponsesWebSearchTool | undefined,
): Record<string, unknown> => {
  if (hosted === undefined) return {};
  const settings: Record<string, unknown> = {};
  for (const key of ALPHA_SEARCH_SETTING_KEYS) {
    if (hosted[key] !== undefined) settings[key] = hosted[key];
  }
  return settings;
};

const extractFilters = (tool: OpenAIResponsesWebSearchTool): WebSearchFilters => {
  const out: WebSearchFilters = {};
  if (tool.filters?.allowed_domains) out.allowedDomains = tool.filters.allowed_domains;
  if (tool.filters?.blocked_domains) out.blockedDomains = tool.filters.blocked_domains;
  if (tool.user_location) {
    const { city, region, country, timezone } = tool.user_location;
    out.userLocation = {
      ...(city == null ? {} : { city }),
      ...(region == null ? {} : { region }),
      ...(country == null ? {} : { country }),
      ...(timezone == null ? {} : { timezone }),
    };
  }
  const size = tool.search_context_size;
  if (size !== undefined && !isSearchContextSize(size)) throw new Error(`Unvalidated web_search search_context_size '${size}'`);
  out.maxResults = maxResultsForContextSize(size);
  return out;
};

interface PrepareToolsError {
  /** Human-readable error message. */
  message: string;
  /** JSON-Pointer-style location inside `tools[]`. */
  param: string;
}

type PrepareToolsResult =
  | { ok: true; filters: WebSearchFilters }
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

// Validate the hosted web-search fields the shim interprets. The model-bound
// replacement uses the shim command schema; backend settings such as
// `external_web_access` are handled separately, while unhandled fields such
// as `return_token_budget` are omitted from that request.
const validateHostedEntry = (tool: OpenAIResponsesWebSearchTool): PrepareToolsError | null => {
  const sizeField = (tool as { search_context_size?: unknown }).search_context_size;
  if (sizeField !== undefined && sizeField !== null && !isSearchContextSize(sizeField)) {
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

// Validate every hosted declaration before selecting the last one's runtime
// filters, so an earlier invalid declaration cannot be masked.
export const prepareToolsForShim = (
  tools: OpenAIResponsesTool[],
  paths?: readonly string[],
): PrepareToolsResult => {
  let selectedFilters: WebSearchFilters = {};
  for (const [index, tool] of tools.entries()) {
    if (isHostedWebSearchTool(tool)) {
      const reject = validateHostedEntry(tool);
      if (reject !== null) {
        const path = paths?.[index];
        return {
          ok: false,
          error: path?.startsWith('input[')
            ? { ...reject, param: reject.param === 'tools' ? path : `${path}.search_context_size` }
            : reject,
        };
      }
      selectedFilters = extractFilters(tool);
    }
  }
  return { ok: true, filters: selectedFilters };
};

// Cap on the wire-item dump inlined into the malformed-input branch's
// `function_call_output` placeholder. A pathological prior wsc echo
// (deeply nested, multi-kilobyte) shouldn't get to blow the upstream
// context window through the diagnostic that explains it.
const MAX_MALFORMED_WIRE_DUMP_CHARS = 1024;

const isWebSearchReplayIr = (value: unknown): value is WebSearchCallIR => {
  if (value === null || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return obj.action !== undefined && Array.isArray(obj.results);
};

export const synthesizeWebSearchCallId = (): string => createRandomOpenAIResponsesItemId('web_search_call');

// Distinct id namespace (cc_replay_*) from web-search item ids (ws_*) so a
// replay call_id never reads as a web-search item id in logs.
const synthesizeReplayCallId = (): string => shortId('cc_replay');

// Re-serializes a wire `action` back into the shim's JSON arguments
// shape (`{search_query:[{q}]}` / `{open:[{ref_id}]}` /
// `{find:[{ref_id,pattern}]}`). Used only on the replay-fallback path to
// reconstruct arguments for hosted items that arrived without our replay data.
const actionToShimCallArgsJson = (action: OpenAIResponsesWebSearchAction): string => {
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

// Signed replay data retains results independently of include. Foreign
// items without that data cannot supply the original model-facing result.
export const expandWebSearchCall = (
  item: OpenAIResponsesInputWebSearchCall,
  replay?: { data: unknown },
): ServerToolHistoryExpansion => {
  if (replay !== undefined) {
    if (!isWebSearchReplayIr(replay.data)) throw new TypeError('Invalid web search replay data');
    if (isEqual(replay.data.action, item.action)) return { callSource: 'replay', output: renderWebSearchCallOutput(replay.data) };
  }

  if (item.action === undefined) {
    const callId = synthesizeReplayCallId();
    // Truncate the wire dump so a deeply-nested or large prior item
    // doesn't blow the upstream context window via a multi-kilobyte
    // function_call_output. The model still sees enough to recognize
    // the malformed shape.
    const wireDump = truncatePreservingCodePoints(JSON.stringify(item), MAX_MALFORMED_WIRE_DUMP_CHARS);
    return {
      callSource: 'synthesized',
      synthesizedCall: { callId, arguments: '{}' },
      output: `A prior web_search_call item in the conversation history was malformed (no \`action\` field). Original wire item: ${wireDump}`,
    };
  }

  const callId = synthesizeReplayCallId();
  return {
    callSource: 'synthesized',
    synthesizedCall: { callId, arguments: actionToShimCallArgsJson(item.action) },
    output: 'Prior search results were not preserved in the conversation history. Call web_search again if you need them.',
  };
};

interface ShimState {
  filters: WebSearchFilters;
  includeSearchResults: boolean;
  includeSearchActionSources: boolean;
  executeAlpha?: (commands: Record<string, unknown>, action: OpenAIResponsesWebSearchAction, context: HostedToolContext) => Promise<SearchResult>;
}

type SearchResult = WebSearchCallIR | { failure: HostedToolFailure };

export const decodeHostedAlphaSearchOutput = (result: Uint8Array | JsonObject): Result<string, ProtocolError> => {
  const decoded = result instanceof Uint8Array ? parseJsonBody(result) : { ok: true as const, value: result };
  if (decoded.ok && isJsonObject(decoded.value) && typeof decoded.value.output === 'string') {
    return { ok: true, value: decoded.value.output };
  }
  return {
    ok: false,
    error: {
      kind: 'error',
      source: 'upstream',
      error: {
        error: {
          message: decoded.ok
            ? 'OpenAI search upstream response must include an output string'
            : `OpenAI search upstream returned malformed JSON: ${decoded.error.message}`,
        },
      },
    },
  };
};

const runLocalSearch = async (
  operations: { kind: 'single'; operation: WebSearchOperation }
    | { kind: 'multi-search'; searches: Array<Extract<WebSearchOperation, { kind: 'search' }>> },
  state: ShimState,
  responseLength: SearchResponseLength | undefined,
  { facts, scope }: HostedToolContext,
): Promise<SearchResult> => {
  const call = scope.run(localWebSearch, {
    'request.auth.apiKeyId': facts['request.auth.apiKeyId'],
    'request.webSearch': {
      kind: 'operations',
      operations,
      filters: state.filters,
      includeSearchActionSources: state.includeSearchActionSources,
      ...(responseLength === undefined ? {} : { responseLength }),
    },
  });
  try {
    const { 'response.webSearch': result } = await call;
    if (result.kind === 'abort') return { failure: result };
    if (result.kind !== 'operations') throw new TypeError('OpenAI Responses web search received the wrong operation result');
    return result.result;
  } finally {
    scope.abort(call);
  }
};

const runAlphaSearch = async (
  sessionId: string,
  commands: Record<string, unknown>,
  settings: Record<string, unknown>,
  action: OpenAIResponsesWebSearchAction,
  { facts, scope }: HostedToolContext,
): Promise<SearchResult> => {
  const call = scope.run(alphaSearchOperation, {
    ...hostedToolRequest(facts, '/v1/alpha/search'),
    'request.alphaSearch': { id: sessionId, input: facts['request.openaiResponses'].input, commands, settings } as JsonObject,
  });
  try {
    const answer = await call;
    scope.abort(call);
    const outcome = answer['response.alphaSearch'];
    discardHostedToolResponse(answer, scope);
    if (outcome.kind === 'error') {
      if (isHostedScalarAbort(outcome, answer['response.http'])) {
        return { failure: { kind: 'abort', cause: scope.signal.reason } };
      }
      const body = isJsonObject(outcome.error) ? outcome.error : {};
      const error = isJsonObject(body.error) ? body.error : body;
      const message = typeof error.message === 'string'
        ? error.message
        : `OpenAI search upstream returned HTTP ${answer['response.http']?.status ?? 502}`;
      if (error.name === UNSUPPORTED_LOCAL_WEB_SEARCH_FEATURE_ERROR_NAME) return unsupportedLocalWebSearchFeatureIr(action, message);
      return { failure: outcome };
    }
    const result = decodeHostedAlphaSearchOutput(outcome.result);
    if (!result.ok) return { failure: result.error };
    return {
      action,
      results: result.value === '' ? [] : [{ type: 'text_result', url: '', title: 'OpenAI search output', snippet: result.value }],
      outputText: result.value,
    };
  } finally {
    scope.abort(call);
  }
};

const ITERATION_CAP = 30;

const planShimSlots = (
  parsed: ParsedWebSearchOperations,
  commands: Record<string, unknown>,
  toolName: string,
  state: ShimState,
  loopState: ServerToolLoopState,
  responseLength: SearchResponseLength | undefined,
  context: HostedToolContext,
): { id: string; resolve: () => Promise<SearchResult> } => {
  if (loopState.iterationCount > ITERATION_CAP) {
    return {
      id: synthesizeWebSearchCallId(),
      resolve: async () => schemaErrorIr(
        'tool budget exhausted',
        'Tool call budget exhausted',
        `Web search iteration limit (${ITERATION_CAP}) reached. Further web_search calls in this response will return this same error. Summarize what you have already learned, and continue the task using other available tools (shell, file inspection, prior knowledge) or directly answer based on what you've gathered.`,
      ),
    };
  }

  if (parsed.kind === 'malformed' || parsed.ops.length === 0) {
    return {
      id: synthesizeWebSearchCallId(),
      resolve: async () => schemaErrorIr(
        'malformed shim call arguments',
        'Malformed arguments',
        'Error: arguments must be a JSON object with sub-property arrays (search_query[], open[], find[]).',
      ),
    };
  }

  const executeAlpha = state.executeAlpha;
  if (executeAlpha !== undefined) {
    const first = parsed.ops[0];
    let action: OpenAIResponsesWebSearchAction;
    if (first.kind === 'search') {
      const queries = parsed.ops.filter((op): op is Extract<WebSearchOperation, { kind: 'search' }> => op.kind === 'search').map(op => op.query);
      action = queries.length === 1
        ? { type: 'search', query: queries[0], queries }
        : { type: 'search', query: queries.join(' | '), queries };
    } else if (first.kind === 'open') {
      action = { type: 'open_page', url: first.url };
    } else if (first.kind === 'find') {
      action = { type: 'find_in_page', url: first.url, pattern: first.pattern };
    } else {
      action = { type: 'search', query: Object.keys(commands).join(', ') };
    }
    return { id: synthesizeWebSearchCallId(), resolve: () => executeAlpha(commands, action, context) };
  }

  try {
    assertLocalWebSearchSupport(commands);
  } catch (error) {
    if (error instanceof UnsupportedLocalWebSearchFeatureError) {
      return {
        id: synthesizeWebSearchCallId(),
        resolve: async () => unsupportedLocalWebSearchFeatureIr(
          { type: 'search', query: Object.keys(commands).join(', ') },
          error.message,
        ),
      };
    }
    return {
      id: synthesizeWebSearchCallId(),
      resolve: async () => { throw error; },
    };
  }

  // Multi-`search_query` entries collapse into one wsc with a multi-query
  // action (`{type:'search', queries:[...]}`) — protocol-native and the
  // only same-kind shape that fits in one wsc. Require every entry to
  // parse cleanly; one malformed entry forces the model to fix all of
  // them rather than silently dropping a search.
  if (parsed.ops.length > 1 && parsed.ops.every(op => op.kind === 'search' && op.error === undefined)) {
    const searchOps = parsed.ops as Array<Extract<WebSearchOperation, { kind: 'search' }>>;
    return {
      id: synthesizeWebSearchCallId(),
      resolve: () => runLocalSearch({ kind: 'multi-search', searches: searchOps }, state, responseLength, context),
    };
  }

  // Any other multi-op shape cannot reduce to a single wsc action: `open`
  // and `find` actions each carry one url/pattern, and mixed kinds have
  // incompatible action types. Surface as ambiguous and let the model
  // split into independent calls.
  if (parsed.ops.length > 1) {
    return {
      id: synthesizeWebSearchCallId(),
      resolve: async () => schemaErrorIr(
        'ambiguous shim call',
        'Ambiguous tool call',
        `Error: ambiguous \`${toolName}\` tool call — each function_call maps to one web_search_call. `
        + 'Multiple `search_query` entries are fine (they collapse into one search). '
        + 'For `open`/`find`, or any mix of kinds, split into one call per `open[]` entry, `find[]` entry, or `search_query[]` batch.',
      ),
    };
  }

  return {
    id: synthesizeWebSearchCallId(),
    resolve: () => runLocalSearch({ kind: 'single', operation: parsed.ops[0] }, state, responseLength, context),
  };
};

export const webSearchServerTool: ServerToolRegistration = async (facts, scope) => {
  const model = facts['provider.model'];
  const payload = facts['request.openaiResponses'];
  if (model.endpoints.openaiResponses !== undefined && !model.enabledFlags.includes('openai-responses-web-search-shim')) {
    return { type: 'inactive' };
  }

  const declarations = collectOpenAIResponsesToolEntries(payload);
  const tools = declarations.map(entry => entry.tool);
  const hasHostedWebSearch = tools.some(isHostedWebSearchTool);
  const hasReplayInput = payload.input.some(i => i.type === 'web_search_call');
  if (!hasHostedWebSearch && !hasReplayInput) return { type: 'inactive' };

  const prepared = prepareToolsForShim(tools, declarations.map(entry => entry.path));
  if (!prepared.ok) {
    return {
      type: 'invalid-request',
      message: prepared.error.message,
      param: prepared.error.param,
    };
  }

  const { filters } = prepared;
  const config = await scope.services.localWebSearch.configuration();
  const includes = Array.isArray(payload.include) ? payload.include : [];
  const sessionId = crypto.randomUUID();
  const hosted = tools.filter(isHostedWebSearchTool).at(-1);
  const settings = alphaSearchSettingsFromHosted(hosted);
  const state: ShimState = {
    filters,
    includeSearchResults: includes.includes('web_search_call.results'),
    includeSearchActionSources: includes.includes('web_search_call.action.sources'),
    ...(config.passthroughOpenAiSearch.enabled
      ? { executeAlpha: async (commands, action, context) => await runAlphaSearch(sessionId, commands, settings, action, context) }
      : {}),
  };

  return {
    type: 'active',
    baseToolName: SHIM_TOOL_NAME,
    expandHistoryItem: (item, replayData) => item.type === 'web_search_call'
      ? expandWebSearchCall(item, replayData)
      : undefined,
    ...(hasHostedWebSearch
      ? {
          hosted: {
            hostedTypes: WEB_SEARCH_HOSTED_TYPE_NAMES,
            recognizeHostedTool: recognizeWebSearchTool,
            buildFunctionTool: buildShimFunctionTool,
            dispatcher: ({ intercepted, loopState }, context) => {
              const commands = intercepted.parsedArguments ?? {};
              const responseLength = isSearchResponseLength(commands.response_length)
                ? commands.response_length
                : undefined;
              const slot = planShimSlots(
                parseWebSearchOperations(intercepted.parsedArguments),
                commands,
                intercepted.functionCall.name,
                state,
                loopState,
                responseLength,
                context,
              );
              return [{
                id: slot.id,
                startItem: { type: 'web_search_call', status: 'in_progress' },
                startEvents: [
                  { type: 'response.web_search_call.in_progress' },
                  { type: 'response.web_search_call.searching' },
                ],
                run: async function* run() {
                  const ir = await slot.resolve();
                  if ('failure' in ir) return ir;
                  // `results` is gated on the client's `include`
                  // opt-in to match native OpenAI Responses' default wire
                  // shape; the IR keeps them either way for the
                  // replay data.
                  const item: ServerToolOutputItem & Omit<OpenAIResponsesOutputWebSearchCall, 'id'> = state.includeSearchResults
                    ? { type: 'web_search_call', status: 'completed', action: ir.action, results: ir.results }
                    : { type: 'web_search_call', status: 'completed', action: ir.action };
                  return {
                    item,
                    endEvents: [{ type: 'response.web_search_call.completed' }],
                    replayData: ir,
                  };
                },
              }];
            },
          },
        }
      : {}),
  };
};
