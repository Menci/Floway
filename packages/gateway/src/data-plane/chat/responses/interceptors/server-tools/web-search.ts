import { shortId } from '../../../../../shared/short-id.ts';
import { executeAlphaSearch } from '../../../../tools/web-search/alpha-search/execution.ts';
import { resolveAlphaSearchDispatcher } from '../../../../tools/web-search/alpha-search/upstream.ts';
import { normalizeDomainEntry } from '../../../../tools/web-search/domain-normalize.ts';
import {
  actionSearchQueries,
  CONTEXT_SIZE_TO_MAX_RESULTS,
  DEFAULT_SEARCH_CONTEXT_SIZE,
  executeOperationToIr,
  isSearchContextSize,
  maxResultsForContextSize,
  parseWebSearchOperations,
  renderWebSearchCallOutput,
  runBackendSearchMulti,
  schemaErrorIr,
  startBatchFetch,
  type ParsedWebSearchOperations,
  type WebSearchCallIR,
  type WebSearchExecutionSession,
  type WebSearchFilters,
  type WebSearchOperation,
} from '../../../../tools/web-search/operations.ts';
import { resolveConfiguredWebSearchProvider } from '../../../../tools/web-search/provider.ts';
import { loadSearchConfig } from '../../../../tools/web-search/search-config.ts';
import type { ConfiguredWebSearchProvider } from '../../../../tools/web-search/types.ts';
import { truncatePreservingCodePoints } from '../../../shared/text.ts';
import { type ServerToolLoopState, type ServerToolOutputItem, type ServerToolRegistration } from '../server-tool-shim.ts';
import type { ResponsesFunctionTool, ResponsesFunctionToolCallItem, ResponsesHostedTool, ResponsesInputItem, ResponsesOutputWebSearchCall, ResponsesTool, ResponsesWebSearchAction } from '@floway-dev/protocols/responses';
import { createRandomResponsesItemId, WEB_SEARCH_HOSTED_TYPE_NAMES } from '@floway-dev/protocols/responses';
import { providerModelOf } from '@floway-dev/provider';

// Runtime set derived from the canonical tuple declared next to
// `ResponsesHostedToolType` so the type union and runtime check can't drift.
//   https://github.com/openai/openai-python/blob/e75766769547601a25ed83b666c4d0fd046881f0/src/openai/types/responses/web_search_tool.py
//   https://github.com/openai/openai-python/blob/e75766769547601a25ed83b666c4d0fd046881f0/src/openai/types/responses/web_search_preview_tool.py
export const WEB_SEARCH_HOSTED_TYPES: ReadonlySet<string> = new Set<string>(WEB_SEARCH_HOSTED_TYPE_NAMES);

// Function-name regex `^[a-zA-Z0-9_-]+$` forbids dots, so the shim call
// uses the underscored form of the model's training-time `web.run`.
export const SHIM_TOOL_NAME = 'web_search';

// The hosted tool's `user_location` must surface to the model, not just
// to the backend provider — without this hint the model asks "Which
// city should I check?" even when the client supplied one.
const formatUserLocation = (loc: NonNullable<WebSearchFilters['userLocation']>): string => {
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

const extractFilters = (tool: ResponsesHostedTool): WebSearchFilters => {
  const out: WebSearchFilters = {};
  if (tool.filters?.allowed_domains) out.allowedDomains = tool.filters.allowed_domains;
  if (tool.filters?.blocked_domains) out.blockedDomains = tool.filters.blocked_domains;
  if (tool.user_location) out.userLocation = tool.user_location;
  out.maxResults = maxResultsForContextSize(tool.search_context_size);
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

// Validate the parts of a hosted-web-search entry the shim acts on.
// Anything else (`external_web_access`, `return_token_budget`, etc.)
// is silently dropped along with the hosted tool itself — the shim
// replaces the hosted entry with its shim function tool, so any
// hosted-only field the shim doesn't process never reaches upstream
// regardless.
const validateHostedEntry = (tool: ResponsesHostedTool): PrepareToolsError | null => {
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

// Validation covers every hosted declaration even though only the last one
// supplies runtime filters. Azure and Copilot both use this dedupe-to-last
// rule for repeated web-search declarations.
// https://github.com/Menci/Floway/pull/172#issuecomment-4971739422
export const prepareToolsForShim = (
  tools: ResponsesTool[],
): PrepareToolsResult => {
  let selectedFilters: WebSearchFilters = {};
  for (const tool of tools) {
    if (isHostedWebSearchTool(tool)) {
      const reject = validateHostedEntry(tool);
      if (reject !== null) return { ok: false, error: reject };
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
 * - `ir` stores the action, structured results, and optional upstream
 *   model-facing output straight from `planShimSlots`. Replay uses
 *   `renderWebSearchCallOutput`, which preserves that output when present
 *   and otherwise renders the action and results.
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

export const synthesizeWebSearchCallId = (): string => createRandomResponsesItemId('web_search_call');

// Distinct id namespace (cc_replay_*) from web-search item ids (ws_*) so a
// replay call_id never reads as a web-search item id in logs.
const synthesizeReplayCallId = (): string => shortId('cc_replay');

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

// Replay preprocessor: turns echoed `web_search_call` items back into the
// (function_call, function_call_output) pair the upstream model originally
// saw on turn 1.
//
// Two paths:
//
// 1. Private payload hit (the request resolved the wsc id to a persisted
//    `payload.private`): emit the upstream's literal `functionCallItem`
//    (jsonrepair-canonical args, original call_id) plus a
//    `function_call_output` whose body comes from
//    `renderWebSearchCallOutput`. This is the bit-exact round-trip.
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
          output: renderWebSearchCallOutput(candidatePayload.ir),
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

// The shim's execution session plus the one wire-shaping flag that lives
// only on the Responses side.
interface ShimState extends WebSearchExecutionSession {
  // Set when the client passed `include: ["web_search_call.results"]` on
  // the request. Native Responses gates the `results` field on this
  // include token; the shim follows suit on the wire item — but the IR
  // (and therefore `payload.private`) always carries the real results
  // so a subsequent turn echoing the item id can be hydrated regardless.
  includeSearchResults: boolean;
  executeAlpha?: (commands: Record<string, unknown>, action: ResponsesWebSearchAction) => Promise<WebSearchCallIR>;
}

const ITERATION_CAP = 30;

const planShimSlots = (
  parsed: ParsedWebSearchOperations,
  commands: Record<string, unknown>,
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

  if (state.executeAlpha !== undefined) {
    const first = parsed.ops[0];
    let action: ResponsesWebSearchAction;
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
    return { id: synthesizeWebSearchCallId(), promise: state.executeAlpha(commands, action) };
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

  return {
    id: synthesizeWebSearchCallId(),
    promise: startBatchFetch(parsed, state).then(batch => executeOperationToIr(parsed.ops[0], state, batch)),
  };
};

export const webSearchServerTool: ServerToolRegistration = async (invocation, gatewayCtx) => {
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
  const searchConfig = await loadSearchConfig();
  const includeArray = Array.isArray(invocation.payload.include) ? invocation.payload.include : [];
  let configuredProvider: Promise<ConfiguredWebSearchProvider> | undefined;
  const state: ShimState = {
    filters,
    pageCache: new Map(),
    getProvider: () => {
      configuredProvider ??= Promise.resolve(resolveConfiguredWebSearchProvider(searchConfig));
      return configuredProvider;
    },
    apiKeyId: gatewayCtx.apiKeyId,
    includeSearchResults: includeArray.includes('web_search_call.results'),
    includeSearchActionSources: includeArray.includes('web_search_call.action.sources'),
    ...(gatewayCtx.abortSignal !== undefined ? { signal: gatewayCtx.abortSignal } : {}),
  };
  if (searchConfig.passthroughOpenAiSearch.enabled) {
    const dispatcher = resolveAlphaSearchDispatcher({
      config: searchConfig.passthroughOpenAiSearch,
      upstreamIds: gatewayCtx.upstreamIds,
      scheduler: gatewayCtx.backgroundScheduler,
      runtimeLocation: gatewayCtx.runtimeLocation,
    });
    const sessionId = crypto.randomUUID();
    const hosted = tools.filter(isHostedWebSearchTool).at(-1);
    const settings: Record<string, unknown> = {
      ...(hosted?.search_context_size === undefined ? {} : { search_context_size: hosted.search_context_size }),
      ...(hosted?.filters === undefined ? {} : { filters: hosted.filters }),
      ...(hosted?.user_location === undefined ? {} : { user_location: hosted.user_location }),
    };
    state.executeAlpha = async (commands, action) => await executeAlphaSearch({
      dispatcher: await dispatcher,
      sessionId,
      commands,
      settings,
      input: invocation.payload.input,
      action,
      signal: gatewayCtx.abortSignal,
    });
  }

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
              const commands = intercepted.arguments ?? {};
              const slot = planShimSlots(parseWebSearchOperations(intercepted.arguments), commands, intercepted.name, state, loopState);
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
