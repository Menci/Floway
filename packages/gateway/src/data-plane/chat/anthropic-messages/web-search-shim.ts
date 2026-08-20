
import { decodeBase64UrlJson, encodeBase64UrlJson } from '../../../shared/base64url-json.ts';
import { isJsonObject } from '../../../shared/json-helpers.ts';
import { loadWebSearchConfig } from '../../tools/web-search/config.ts';
import { resolveConfiguredWebSearchProvider } from '../../tools/web-search/provider.ts';
import { runWebSearchAndRecordUsage } from '../../tools/web-search/search.ts';
import type { WebSearchProvider, WebSearchProviderName, WebSearchProviderRequest, WebSearchProviderResult } from '../../tools/web-search/types.ts';
import type {
  AnthropicMessagesAssistantContentBlock,
  AnthropicMessagesAssistantInputContentBlock,
  AnthropicMessagesClientTool,
  AnthropicMessagesMessage,
  AnthropicMessagesNativeWebSearchTool,
  AnthropicMessagesPayload,
  AnthropicMessagesSearchResultBlock,
  AnthropicMessagesStreamEvent,
  AnthropicMessagesTextCitation,
  AnthropicMessagesTool,
  AnthropicMessagesToolResultBlock,
  AnthropicMessagesUserContentBlock,
  AnthropicMessagesWebSearchErrorCode,
  AnthropicMessagesWebSearchResultBlock,
  AnthropicMessagesWebSearchToolResultError,
} from '@floway-dev/protocols/anthropic-messages';
import { ANTHROPIC_MESSAGES_WEB_SEARCH_ERROR_CODES } from '@floway-dev/protocols/anthropic-messages';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { AnthropicMessagesInvocation } from '@floway-dev/provider';
import { providerModelOf } from '@floway-dev/provider';

const MAX_QUERY_LENGTH = 1000;
const WEB_SEARCH_TOOL_NAME = 'web_search';

type SearchResultOwnership = 'owned' | 'foreign';

interface ShimWebSearchResultPayload {
  content: Array<{ type: 'text'; text: string }>;
}

interface ShimWebSearchCitationPayload {
  search_result_index: number;
  start_block_index: number;
  end_block_index: number;
}

interface OwnedReplayToolResult {
  upstreamToolResult: AnthropicMessagesToolResultBlock;
  searchResultOwnership: SearchResultOwnership[];
}

interface ReplayAwareAnthropicMessagesWebSearchShimState {
  priorSearchUseCount: number;
  requestSearchResultOwnership: SearchResultOwnership[];
}

interface ActiveAnthropicMessagesWebSearchProvider {
  providerName: WebSearchProviderName;
  impl: WebSearchProvider;
  apiKeyId: string;
}

export type AnthropicMessagesWebSearchShimState =
  | {
    mode: 'inactive';
  }
  | ({
    mode: 'replay_only';
  } & ReplayAwareAnthropicMessagesWebSearchShimState)
  | ({
    mode: 'active';
    toolVersion: AnthropicMessagesNativeWebSearchTool['type'];
    maxUses?: number;
    allowedDomains?: string[];
    blockedDomains?: string[];
    userLocation?: {
      city?: string;
      region?: string;
      country?: string;
      timezone?: string;
    };
  } & ReplayAwareAnthropicMessagesWebSearchShimState);

export type PrepareAnthropicMessagesWebSearchShimRequestResult =
  | {
    type: 'ok';
    payload: AnthropicMessagesPayload;
    state: AnthropicMessagesWebSearchShimState;
  }
  | {
    type: 'invalid-request';
    message: string;
  };

// Official Anthropic API exposes native web_search to the model with this
// description and query-only input schema, and requires the native tool name to
// be exactly `web_search` when present.
const UPSTREAM_WEB_SEARCH_TOOL_DEFINITION: AnthropicMessagesClientTool = {
  name: WEB_SEARCH_TOOL_NAME,
  description: 'The web_search tool searches the internet and returns up-to-date information from web sources.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query',
      },
    },
    required: ['query'],
  },
};

const normalizeNonEmptyDomainList = (domains?: string[]): string[] | undefined => {
  const normalized = domains?.map(domain => domain.trim()).filter(domain => domain.length > 0);
  return normalized && normalized.length > 0 ? [...new Set(normalized)] : undefined;
};

const hasExactKeys = (value: Record<string, unknown>, keys: string[]): boolean => {
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && actualKeys.every(key => keys.includes(key));
};

const isNonNegativeInteger = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;

const isShimWebSearchResultPayload = (value: unknown): value is ShimWebSearchResultPayload => {
  if (!isJsonObject(value)) {
    return false;
  }

  if (!hasExactKeys(value, ['content'])) {
    return false;
  }

  const content = value.content;
  return Array.isArray(content) && content.every(block => block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string');
};

const isShimWebSearchCitationPayload = (value: unknown): value is ShimWebSearchCitationPayload => {
  if (!isJsonObject(value)) {
    return false;
  }

  if (!hasExactKeys(value, ['search_result_index', 'start_block_index', 'end_block_index'])) {
    return false;
  }

  return (
    isNonNegativeInteger(value.search_result_index) && isNonNegativeInteger(value.start_block_index) && isNonNegativeInteger(value.end_block_index) && value.end_block_index >= value.start_block_index
  );
};

export const encodeWebSearchResultPayload = (payload: ShimWebSearchResultPayload): string => encodeBase64UrlJson(payload);

// Replay detection is purely structural: a foreign upstream's opaque
// `encrypted_content` / `encrypted_index` will fail base64url+JSON decoding or
// fail the strict exact-keys schema validators above, so it round-trips through
// the shim untouched.
export const decodeWebSearchResultPayload = (value: string): ShimWebSearchResultPayload | null => {
  const decoded = decodeBase64UrlJson(value);
  return isShimWebSearchResultPayload(decoded) ? decoded : null;
};

export const encodeWebSearchCitationPayload = (payload: ShimWebSearchCitationPayload): string => encodeBase64UrlJson(payload);

export const decodeWebSearchCitationPayload = (value: string): ShimWebSearchCitationPayload | null => {
  const decoded = decodeBase64UrlJson(value);
  return isShimWebSearchCitationPayload(decoded) ? decoded : null;
};

const isNativeWebSearchToolDefinition = (tool: AnthropicMessagesTool): tool is AnthropicMessagesNativeWebSearchTool => tool.type === 'web_search_20250305' || tool.type === 'web_search_20260209';

const anthropicMessagesWebSearchErrorCodeSet = new Set<string>(ANTHROPIC_MESSAGES_WEB_SEARCH_ERROR_CODES);

const isAnthropicMessagesWebSearchErrorCode = (value: unknown): value is AnthropicMessagesWebSearchErrorCode => typeof value === 'string' && anthropicMessagesWebSearchErrorCodeSet.has(value);

const isWebSearchToolResultError = (value: unknown): value is AnthropicMessagesWebSearchToolResultError =>
  isJsonObject(value) && value.type === 'web_search_tool_result_error' && isAnthropicMessagesWebSearchErrorCode(value.error_code);

const toUpstreamToolUseId = (toolUseId: string): string => (toolUseId.startsWith('srvtoolu_') ? `toolu_${toolUseId.slice('srvtoolu_'.length)}` : toolUseId);

const toNativeServerToolUseId = (toolUseId: string): string => (toolUseId.startsWith('toolu_') ? `srvtoolu_${toolUseId.slice('toolu_'.length)}` : toolUseId);

const buildUpstreamSearchResultBlock = (result: AnthropicMessagesWebSearchResultBlock, decoded: NonNullable<ReturnType<typeof decodeWebSearchResultPayload>>): AnthropicMessagesSearchResultBlock => ({
  type: 'search_result',
  source: result.url,
  title: result.title,
  content: decoded.content,
  citations: { enabled: true },
});

const buildNativeWebSearchErrorResultBlock = (toolUseId: string, errorCode: AnthropicMessagesWebSearchErrorCode): Extract<AnthropicMessagesAssistantContentBlock, { type: 'web_search_tool_result' }> => ({
  type: 'web_search_tool_result',
  tool_use_id: toNativeServerToolUseId(toolUseId),
  content: { type: 'web_search_tool_result_error', error_code: errorCode },
  caller: { type: 'direct' },
});

const buildNativeWebSearchServerToolUseBlock = (toolUseId: string, query: string): Extract<AnthropicMessagesAssistantContentBlock, { type: 'server_tool_use' }> => ({
  type: 'server_tool_use',
  id: toNativeServerToolUseId(toolUseId),
  name: WEB_SEARCH_TOOL_NAME,
  input: { query },
});

const buildNativeWebSearchResultBlock = (result: Extract<WebSearchProviderResult, { type: 'ok' }>['results'][number]): AnthropicMessagesWebSearchResultBlock => ({
  type: 'web_search_result',
  url: result.source,
  title: result.title,
  encrypted_content: encodeWebSearchResultPayload({
    content: result.content,
  }),
  ...(result.pageAge ? { page_age: result.pageAge } : {}),
});

// Error-only replay blocks do not carry our encoded payload marker, so the
// safest replay rule is structural: only decode results that are paired with
// a same-message `server_tool_use` we can turn back into upstream tool history.
const collectOwnedReplayResultsByServerToolUseId = (content: AnthropicMessagesAssistantInputContentBlock[]): Map<string, OwnedReplayToolResult> => {
  const pairedServerToolUseIds = new Set(content.flatMap(block => (block.type === 'server_tool_use' && block.name === WEB_SEARCH_TOOL_NAME ? [block.id] : [])));
  const ownedReplayResultsByServerToolUseId = new Map<string, OwnedReplayToolResult>();

  for (const block of content) {
    if (block.type !== 'web_search_tool_result' || !pairedServerToolUseIds.has(block.tool_use_id)) {
      continue;
    }

    const ownedReplayResult = decodeOwnedReplayToolResult(block);
    if (!ownedReplayResult) {
      continue;
    }

    ownedReplayResultsByServerToolUseId.set(block.tool_use_id, ownedReplayResult);
  }

  return ownedReplayResultsByServerToolUseId;
};

const messageHasOwnedReplayMarkers = (message: AnthropicMessagesMessage): boolean => {
  if (message.role !== 'assistant' || !Array.isArray(message.content)) {
    return false;
  }

  return (
    collectOwnedReplayResultsByServerToolUseId(message.content).size > 0 ||
    message.content.some(block => {
      if (block.type !== 'text' || !block.citations) {
        return false;
      }

      return block.citations.some(citation => citation.type === 'web_search_result_location' && decodeWebSearchCitationPayload(citation.encrypted_index) !== null);
    })
  );
};

const decodeOwnedReplayCitation = (citation: AnthropicMessagesTextCitation): AnthropicMessagesTextCitation => {
  if (citation.type !== 'web_search_result_location') {
    return citation;
  }

  const decoded = decodeWebSearchCitationPayload(citation.encrypted_index);
  if (!decoded) {
    return citation;
  }

  return {
    type: 'search_result_location',
    url: citation.url,
    title: citation.title,
    search_result_index: decoded.search_result_index,
    start_block_index: decoded.start_block_index,
    end_block_index: decoded.end_block_index,
    ...(citation.cited_text ? { cited_text: citation.cited_text } : {}),
  };
};

const decodeOwnedReplayToolResult = (block: Extract<AnthropicMessagesAssistantInputContentBlock, { type: 'web_search_tool_result' }>): OwnedReplayToolResult | null => {
  if (Array.isArray(block.content)) {
    const decodedResults = block.content.map(result => ({
      result,
      payload: decodeWebSearchResultPayload(result.encrypted_content),
    }));

    if (decodedResults.some(entry => entry.payload === null)) {
      return null;
    }

    return {
      upstreamToolResult: {
        type: 'tool_result',
        tool_use_id: toUpstreamToolUseId(block.tool_use_id),
        content: decodedResults.map(({ result, payload }) => buildUpstreamSearchResultBlock(result, payload!)),
      },
      searchResultOwnership: decodedResults.map(() => 'owned'),
    };
  }

  if (isWebSearchToolResultError(block.content)) {
    // Intentionally do not decode or rewrite native-looking
    // `web_search_tool_result_error` history. Copilot upstream accepts the
    // Anthropic API-reference error-code payloads directly, and downstream-
    // supplied native error history is downstream-owned. This shim only
    // rewrites result arrays that carry our unsigned replay payload.
    return null;
  }

  return null;
};

const collectForeignSearchResultOwnership = (content: string | AnthropicMessagesUserContentBlock[]): SearchResultOwnership[] => {
  if (typeof content === 'string') {
    return [];
  }

  return content.flatMap(block => {
    if (block.type !== 'tool_result' || !Array.isArray(block.content)) {
      return [];
    }

    return block.content.flatMap(contentBlock => (contentBlock.type === 'search_result' ? ['foreign' as const] : []));
  });
};

interface PreparedAnthropicMessagesWebSearchReplay {
  hasOwnedReplay: boolean;
  messages: AnthropicMessagesMessage[];
  priorSearchUseCount: number;
  requestSearchResultOwnership: SearchResultOwnership[];
}

const prepareAnthropicMessagesWebSearchReplay = (messages: AnthropicMessagesMessage[]): PreparedAnthropicMessagesWebSearchReplay => {
  const hasOwnedReplay = messages.some(messageHasOwnedReplayMarkers);
  const rewrittenMessages: AnthropicMessagesMessage[] = [];
  const requestSearchResultOwnership: SearchResultOwnership[] = [];
  let pendingOwnedReplayToolResults: OwnedReplayToolResult[] = [];
  let priorSearchUseCount = 0;

  const flushPendingOwnedReplayToolResults = () => {
    if (pendingOwnedReplayToolResults.length === 0) {
      return;
    }

    rewrittenMessages.push({ role: 'user' as const, content: pendingOwnedReplayToolResults.map(({ upstreamToolResult }) => upstreamToolResult) });
    requestSearchResultOwnership.push(...pendingOwnedReplayToolResults.flatMap(({ searchResultOwnership }) => searchResultOwnership));
    pendingOwnedReplayToolResults = [];
  };

  for (const message of messages) {
    if (pendingOwnedReplayToolResults.length > 0 && message.role !== 'user') {
      flushPendingOwnedReplayToolResults();
    }

    if (message.role === 'user') {
      const foreignSearchResultOwnership = collectForeignSearchResultOwnership(message.content);

      if (pendingOwnedReplayToolResults.length > 0 && Array.isArray(message.content) && message.content.some(block => block.type === 'tool_result')) {
        const toolResults = pendingOwnedReplayToolResults.map(({ upstreamToolResult }) => upstreamToolResult);
        rewrittenMessages.push({ role: 'user', content: [...toolResults, ...(typeof message.content === 'string' ? [{ type: 'text' as const, text: message.content }] : message.content)] });
        requestSearchResultOwnership.push(...pendingOwnedReplayToolResults.flatMap(({ searchResultOwnership }) => searchResultOwnership), ...foreignSearchResultOwnership);
        pendingOwnedReplayToolResults = [];
        continue;
      }

      flushPendingOwnedReplayToolResults();
      rewrittenMessages.push(message);
      requestSearchResultOwnership.push(...foreignSearchResultOwnership);
      continue;
    }

    if (!Array.isArray(message.content)) {
      rewrittenMessages.push(message);
      continue;
    }

    // System messages with array content pass through unchanged: the
    // remaining rewrite path below assumes assistant-shape content
    // (server_tool_use, web_search_tool_result, citations) and finalizes
    // with `role: 'assistant'`, which would silently corrupt an
    // AnthropicMessagesSystemMessage carrying AnthropicMessagesTextBlock[] into an assistant
    // turn. System messages never own web-search replay markers.
    if (message.role === 'system') {
      rewrittenMessages.push(message);
      continue;
    }

    const ownedReplayResultsByServerToolUseId = collectOwnedReplayResultsByServerToolUseId(message.content);

    for (const ownedReplayResult of ownedReplayResultsByServerToolUseId.values()) {
      priorSearchUseCount += 1;
      pendingOwnedReplayToolResults.push(ownedReplayResult);
    }

    const rewrittenContent = message.content.flatMap((block): AnthropicMessagesAssistantInputContentBlock[] => {
      if (block.type === 'server_tool_use' && ownedReplayResultsByServerToolUseId.has(block.id)) {
        return [
          {
            type: 'tool_use',
            id: toUpstreamToolUseId(block.id),
            name: block.name,
            input: block.input,
          },
        ];
      }

      if (block.type === 'web_search_tool_result' && ownedReplayResultsByServerToolUseId.has(block.tool_use_id)) {
        return [];
      }

      if (block.type !== 'text' || !block.citations) {
        return [block];
      }

      return [{
        type: 'text',
        text: block.text,
        citations: block.citations.map(decodeOwnedReplayCitation),
      }];
    });

    rewrittenMessages.push({
      role: 'assistant',
      content: rewrittenContent,
    });
  }

  flushPendingOwnedReplayToolResults();

  return {
    hasOwnedReplay,
    messages: rewrittenMessages,
    priorSearchUseCount,
    requestSearchResultOwnership,
  };
};

const validateNativeWebSearchToolDefinitions = (payload: AnthropicMessagesPayload): { type: 'ok'; nativeTool?: AnthropicMessagesNativeWebSearchTool } | { type: 'invalid-request'; message: string } => {
  const nativeToolEntries = (payload.tools ?? []).flatMap((tool, index) => (isNativeWebSearchToolDefinition(tool) ? [{ tool, index }] : []));

  if (nativeToolEntries.length > 1) {
    return {
      type: 'invalid-request',
      message: 'Only one native web search tool definition is supported per request.',
    };
  }

  const nativeTool = nativeToolEntries[0]?.tool;
  if (nativeTool?.name !== undefined && nativeTool.name !== WEB_SEARCH_TOOL_NAME) {
    return {
      type: 'invalid-request',
      message: `tools.${nativeToolEntries[0].index}.${nativeTool.type}.name: Input should be '${WEB_SEARCH_TOOL_NAME}'`,
    };
  }

  if (nativeTool && (payload.tools ?? []).some(tool => !isNativeWebSearchToolDefinition(tool) && tool.name === WEB_SEARCH_TOOL_NAME)) {
    return {
      type: 'invalid-request',
      message: `Native web search tool name collides with another client tool: ${WEB_SEARCH_TOOL_NAME}.`,
    };
  }

  return {
    type: 'ok',
    nativeTool,
  };
};

const buildAnthropicMessagesWebSearchShimState = (nativeTool: AnthropicMessagesNativeWebSearchTool | undefined, replay: PreparedAnthropicMessagesWebSearchReplay): AnthropicMessagesWebSearchShimState => {
  if (!nativeTool && !replay.hasOwnedReplay) {
    return { mode: 'inactive' };
  }

  if (!nativeTool) {
    return {
      mode: 'replay_only',
      priorSearchUseCount: replay.priorSearchUseCount,
      requestSearchResultOwnership: replay.requestSearchResultOwnership,
    };
  }

  return {
    mode: 'active',
    toolVersion: nativeTool.type,
    maxUses: nativeTool.max_uses,
    allowedDomains: normalizeNonEmptyDomainList(nativeTool.allowed_domains),
    blockedDomains: normalizeNonEmptyDomainList(nativeTool.blocked_domains),
    userLocation: nativeTool.user_location
      ? {
          city: nativeTool.user_location.city,
          region: nativeTool.user_location.region,
          country: nativeTool.user_location.country,
          timezone: nativeTool.user_location.timezone,
        }
      : undefined,
    priorSearchUseCount: replay.priorSearchUseCount,
    requestSearchResultOwnership: replay.requestSearchResultOwnership,
  };
};

export const prepareAnthropicMessagesWebSearchShimRequest = (payload: AnthropicMessagesPayload): PrepareAnthropicMessagesWebSearchShimRequestResult => {
  const validatedNativeTools = validateNativeWebSearchToolDefinitions(payload);
  if (validatedNativeTools.type !== 'ok') {
    return validatedNativeTools;
  }

  const replay = prepareAnthropicMessagesWebSearchReplay(payload.messages);
  const state = buildAnthropicMessagesWebSearchShimState(validatedNativeTools.nativeTool, replay);

  if (state.mode === 'inactive') {
    return {
      type: 'ok',
      payload,
      state,
    };
  }

  return {
    type: 'ok',
    payload: {
      ...payload,
      ...(payload.tools
        ? {
            tools: validatedNativeTools.nativeTool
              ? payload.tools.map(tool => (isNativeWebSearchToolDefinition(tool) ? UPSTREAM_WEB_SEARCH_TOOL_DEFINITION : tool))
              : payload.tools,
          }
        : {}),
      messages: replay.messages,
    },
    state,
  };
};

const rewriteResponseCitationToNative = (citation: AnthropicMessagesTextCitation, state: AnthropicMessagesWebSearchShimState): AnthropicMessagesTextCitation => {
  if (state.mode === 'inactive' || citation.type !== 'search_result_location') {
    return citation;
  }

  if (state.requestSearchResultOwnership[citation.search_result_index] !== 'owned') {
    return citation;
  }

  return {
    type: 'web_search_result_location',
    url: citation.url,
    title: citation.title,
    encrypted_index: encodeWebSearchCitationPayload({
      search_result_index: citation.search_result_index,
      start_block_index: citation.start_block_index,
      end_block_index: citation.end_block_index,
    }),
    ...(citation.cited_text ? { cited_text: citation.cited_text } : {}),
  };
};

const buildNativeWebSearchResultBlockFromProviderResult = (result: WebSearchProviderResult, toolUseId: string): Extract<AnthropicMessagesAssistantContentBlock, { type: 'web_search_tool_result' }> => {
  if (result.type === 'error') {
    return buildNativeWebSearchErrorResultBlock(toolUseId, result.errorCode);
  }

  return {
    type: 'web_search_tool_result',
    tool_use_id: toNativeServerToolUseId(toolUseId),
    content: result.results.map(buildNativeWebSearchResultBlock),
    caller: { type: 'direct' },
  };
};

// Per-block sub-state captured while walking upstream content blocks. Anthropic Messages
// SSE serializes blocks (no interleaving), so a single ActiveBlock at a time is
// sufficient; an interleaving upstream is treated as a protocol violation.
type ActiveBlock =
  | { kind: 'passthrough'; downstreamIndex: number }
  | { kind: 'text'; downstreamIndex: number }
  | {
    kind: 'web-search-tool-use';
    upstreamToolUseId: string;
    serverToolUseIndex: number;
    resultIndex: number;
    inputJson: string;
  };

interface ShimStreamingState {
  downstreamIndexOffset: number;
  currentSearchUseCount: number;
  executedSearchCount: number;
  interceptedSearches: number;
  hasRemainingClientToolUse: boolean;
}

const rewriteContentBlockStartCitations = (
  event: Extract<AnthropicMessagesStreamEvent, { type: 'content_block_start' }>,
  state: AnthropicMessagesWebSearchShimState,
): Extract<AnthropicMessagesStreamEvent, { type: 'content_block_start' }> => {
  if (event.content_block.type !== 'text' || !event.content_block.citations?.length) {
    return event;
  }

  return {
    ...event,
    content_block: {
      ...event.content_block,
      citations: event.content_block.citations.map(citation => rewriteResponseCitationToNative(citation, state)),
    },
  };
};

const rewriteContentBlockDeltaCitations = (
  event: Extract<AnthropicMessagesStreamEvent, { type: 'content_block_delta' }>,
  state: AnthropicMessagesWebSearchShimState,
): Extract<AnthropicMessagesStreamEvent, { type: 'content_block_delta' }> => {
  if (event.delta.type === 'text_delta' && event.delta.citations?.length) {
    return {
      ...event,
      delta: {
        ...event.delta,
        citations: event.delta.citations.map(citation => rewriteResponseCitationToNative(citation, state)),
      },
    };
  }

  if (event.delta.type === 'citations_delta') {
    return {
      ...event,
      delta: {
        type: 'citations_delta',
        citation: rewriteResponseCitationToNative(event.delta.citation, state),
      },
    };
  }

  return event;
};

// Synthesised events use the canonical Anthropic Messages SSE shape for `server_tool_use`
// and `web_search_tool_result` blocks (input baked into the start event, no
// `input_json_delta`) so downstream clients see the same bytes Anthropic would
// emit for native server tools.
const runWebSearchStopHandler = async function* (
  block: Extract<ActiveBlock, { kind: 'web-search-tool-use' }>,
  shimState: ShimStreamingState,
  state: Extract<AnthropicMessagesWebSearchShimState, { mode: 'active' }>,
  provider: ActiveAnthropicMessagesWebSearchProvider,
): AsyncGenerator<ProtocolFrame<AnthropicMessagesStreamEvent>> {
  const parsedInput = (() => {
    if (block.inputJson === '') return null;
    try {
      const parsed = JSON.parse(block.inputJson);
      return isJsonObject(parsed) ? parsed : null;
    } catch {
      return null;
    }
  })();

  const query = parsedInput ? (typeof parsedInput.query === 'string' ? parsedInput.query.trim() : null) : null;

  shimState.interceptedSearches += 1;

  yield eventFrame({
    type: 'content_block_start',
    index: block.serverToolUseIndex,
    content_block: buildNativeWebSearchServerToolUseBlock(block.upstreamToolUseId, query ?? ''),
  });
  yield eventFrame({ type: 'content_block_stop', index: block.serverToolUseIndex });

  const resultBlock = await (async () => {
    if (state.maxUses !== undefined && shimState.currentSearchUseCount >= state.maxUses) {
      return buildNativeWebSearchErrorResultBlock(block.upstreamToolUseId, 'max_uses_exceeded');
    }

    if (!query || query.length === 0) {
      return buildNativeWebSearchErrorResultBlock(block.upstreamToolUseId, 'invalid_tool_input');
    }

    if (query.length > MAX_QUERY_LENGTH) {
      return buildNativeWebSearchErrorResultBlock(block.upstreamToolUseId, 'query_too_long');
    }

    shimState.executedSearchCount += 1;
    shimState.currentSearchUseCount += 1;

    try {
      const request: WebSearchProviderRequest = {
        query,
        allowedDomains: state.allowedDomains,
        blockedDomains: state.blockedDomains,
        userLocation: state.userLocation,
      };
      const providerResult = await runWebSearchAndRecordUsage({ provider: provider.impl, providerName: provider.providerName, keyId: provider.apiKeyId, request });
      return buildNativeWebSearchResultBlockFromProviderResult(providerResult, block.upstreamToolUseId);
    } catch {
      // TODO: Add gateway-side recent web-search error-log storage so operators can inspect detailed provider/runtime failures even though the client-visible native error intentionally collapses them to `unavailable`.
      return buildNativeWebSearchErrorResultBlock(block.upstreamToolUseId, 'unavailable');
    }
  })();

  yield eventFrame({
    type: 'content_block_start',
    index: block.resultIndex,
    content_block: {
      type: 'web_search_tool_result',
      tool_use_id: resultBlock.tool_use_id,
      content: resultBlock.content,
    },
  });
  yield eventFrame({ type: 'content_block_stop', index: block.resultIndex });

  shimState.downstreamIndexOffset += 1;
};

export const rewriteAnthropicMessagesWebSearchEventsToNative = async function* (
  frames: AsyncIterable<ProtocolFrame<AnthropicMessagesStreamEvent>>,
  state: AnthropicMessagesWebSearchShimState,
  provider?: ActiveAnthropicMessagesWebSearchProvider,
): AsyncGenerator<ProtocolFrame<AnthropicMessagesStreamEvent>> {
  if (state.mode === 'inactive') {
    yield* frames;
    return;
  }

  if (state.mode === 'active' && !provider) {
    throw new Error('Active messages web-search rewrite requires a provider.');
  }

  const shimState: ShimStreamingState = {
    downstreamIndexOffset: 0,
    currentSearchUseCount: state.priorSearchUseCount,
    executedSearchCount: 0,
    interceptedSearches: 0,
    hasRemainingClientToolUse: false,
  };

  let activeBlock: ActiveBlock | undefined;

  for await (const frame of frames) {
    if (frame.type === 'done') {
      yield frame;
      continue;
    }

    const event = frame.event;

    if (event.type === 'content_block_start') {
      if (activeBlock !== undefined) {
        throw new Error('upstream Anthropic Messages SSE interleaved content blocks; web-search shim cannot renumber.');
      }

      const downstreamBase = event.index + shimState.downstreamIndexOffset;

      if (state.mode === 'active' && event.content_block.type === 'tool_use' && event.content_block.name === WEB_SEARCH_TOOL_NAME) {
        activeBlock = {
          kind: 'web-search-tool-use',
          upstreamToolUseId: event.content_block.id,
          serverToolUseIndex: downstreamBase,
          resultIndex: downstreamBase + 1,
          inputJson: '',
        };
        continue;
      }

      if (event.content_block.type === 'text') {
        activeBlock = { kind: 'text', downstreamIndex: downstreamBase };
        yield eventFrame({ ...rewriteContentBlockStartCitations(event, state), index: downstreamBase });
        continue;
      }

      if (event.content_block.type === 'tool_use') {
        shimState.hasRemainingClientToolUse = true;
      }

      activeBlock = { kind: 'passthrough', downstreamIndex: downstreamBase };
      yield eventFrame({ ...event, index: downstreamBase });
      continue;
    }

    if (event.type === 'content_block_delta') {
      if (activeBlock === undefined) {
        throw new Error('upstream Anthropic Messages SSE emitted content_block_delta without an open block.');
      }

      if (activeBlock.kind === 'web-search-tool-use') {
        if (event.delta.type === 'input_json_delta') {
          activeBlock = { ...activeBlock, inputJson: activeBlock.inputJson + event.delta.partial_json };
        }
        continue;
      }

      if (activeBlock.kind === 'text') {
        yield eventFrame({ ...rewriteContentBlockDeltaCitations(event, state), index: activeBlock.downstreamIndex });
        continue;
      }

      yield eventFrame({ ...event, index: activeBlock.downstreamIndex });
      continue;
    }

    if (event.type === 'content_block_stop') {
      if (activeBlock === undefined) {
        throw new Error('upstream Anthropic Messages SSE emitted content_block_stop without an open block.');
      }

      if (activeBlock.kind === 'web-search-tool-use') {
        if (state.mode !== 'active') {
          throw new Error('web-search shim entered intercept path without active state.');
        }

        yield* runWebSearchStopHandler(activeBlock, shimState, state, provider!);
        activeBlock = undefined;
        continue;
      }

      yield eventFrame({ type: 'content_block_stop', index: activeBlock.downstreamIndex });
      activeBlock = undefined;
      continue;
    }

    // Inject `usage.server_tool_use.web_search_requests` and flip `stop_reason`
    // so the downstream view matches what an upstream with native web_search
    // (Anthropic's own) would have produced.
    if (event.type === 'message_delta') {
      const interceptedAny = shimState.interceptedSearches > 0;
      const baseUsage = event.usage ?? { output_tokens: 0 };
      const newUsage = shimState.executedSearchCount > 0
        ? { ...baseUsage, server_tool_use: { web_search_requests: shimState.executedSearchCount } }
        : baseUsage;

      yield eventFrame({
        type: 'message_delta',
        delta: interceptedAny
          ? { ...event.delta, stop_reason: shimState.hasRemainingClientToolUse ? 'tool_use' : 'pause_turn' }
          : event.delta,
        usage: newUsage,
      });
      continue;
    }

    if (event.type === 'error') {
      yield frame;
      return;
    }

    yield frame;
  }
};

/** The body Anthropic Messages states an unusable tool declaration with. A refusal the gateway
 *  writes is a refusal in this protocol's own words, which is what makes it readable by the
 *  client that sent the declaration. */
export const anthropicMessagesWebSearchInvalidRequestBody = (message: string): Record<string, unknown> => ({
  type: 'error',
  error: {
    type: 'invalid_request_error',
    message,
  },
});

/**
 * The backend a search that will actually run needs.
 *
 * An operator who configured none has made this turn unanswerable, and that is this gateway's
 * own fault rather than a refusal to fail over — so it raises, with the sentence naming which
 * of the two states the configuration is in.
 */
export const resolveActiveAnthropicMessagesWebSearchProvider = async (apiKeyId: string): Promise<ActiveAnthropicMessagesWebSearchProvider> => {
  const webSearchConfig = await loadWebSearchConfig();
  const configuredProvider = resolveConfiguredWebSearchProvider(webSearchConfig);
  if (configuredProvider.type === 'enabled') {
    return { providerName: configuredProvider.provider, impl: configuredProvider.impl, apiKeyId };
  }
  throw new Error(
    configuredProvider.type === 'disabled'
      ? 'Native Anthropic Messages web search requires an enabled search provider.'
      : `Native Anthropic Messages web search is missing the configured ${configuredProvider.provider} credential.`,
  );
};

type PreparedAnthropicMessagesWebSearchShimState = Exclude<AnthropicMessagesWebSearchShimState, { mode: 'inactive' }>;

type PrepareAnthropicMessagesWebSearchInvocationResult =
  | { type: 'inactive' }
  | { type: 'invalid-request'; message: string }
  | { type: 'prepared'; state: PreparedAnthropicMessagesWebSearchShimState };

export const prepareAnthropicMessagesWebSearchInvocation = (ctx: AnthropicMessagesInvocation): PrepareAnthropicMessagesWebSearchInvocationResult => {
  if (ctx.targetApi === 'anthropicMessages' && !providerModelOf(ctx.candidate).enabledFlags.has('anthropic-messages-web-search-shim')) {
    return { type: 'inactive' };
  }

  const prepared = prepareAnthropicMessagesWebSearchShimRequest(ctx.payload);
  if (prepared.type === 'invalid-request') return prepared;
  if (prepared.state.mode === 'inactive') return { type: 'inactive' };

  ctx.payload = prepared.payload;
  return { type: 'prepared', state: prepared.state };
};

/**
 * Anthropic exposes native `web_search_*` server tools, but non-Anthropic-Messages
 * targets cannot run Anthropic server tools. This shim rewrites the native tool
 * definition into an ordinary client `web_search` tool, executes each search
 * the model issues using the gateway's configured provider, and rewrites the
 * response back to the Anthropic native `server_tool_use` /
 * `web_search_tool_result` / `web_search_result_location` shape.
 *
 * The shim is unconditional for non-native Anthropic Messages targets (OpenAI Responses /
 * OpenAI Chat Completions cannot carry Anthropic server tools), and gated by the
 * `anthropic-messages-web-search-shim` flag for native Anthropic Messages targets (the upstream
 * may or may not be able to serve web_search natively).
 */
