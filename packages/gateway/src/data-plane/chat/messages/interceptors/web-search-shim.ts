
import type { MessagesInterceptor } from './types.ts';
import { decodeBase64UrlJson, encodeBase64UrlJson } from '../../../../shared/base64url-json.ts';
import { isJsonObject } from '../../../../shared/json-helpers.ts';
import { resolveConfiguredWebSearchProvider } from '../../../tools/web-search/provider.ts';
import { loadSearchConfig } from '../../../tools/web-search/search-config.ts';
import { searchWebAndRecordUsage } from '../../../tools/web-search/search.ts';
import type { WebSearchProvider, WebSearchProviderName, WebSearchProviderRequest, WebSearchProviderResult } from '../../../tools/web-search/types.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type {
  MessagesAssistantContentBlock,
  MessagesClientTool,
  MessagesMessage,
  MessagesNativeWebSearchTool,
  MessagesPayload,
  MessagesSearchResultBlock,
  MessagesStreamEvent,
  MessagesTextCitation,
  MessagesTool,
  MessagesToolResultBlock,
  MessagesUserContentBlock,
  MessagesWebSearchErrorCode,
  MessagesWebSearchResultBlock,
  MessagesWebSearchToolResultError,
} from '@floway-dev/protocols/messages';
import { MESSAGES_WEB_SEARCH_ERROR_CODES } from '@floway-dev/protocols/messages';
import { providerModelOf, internalErrorResult, toInternalDebugError } from '@floway-dev/provider';

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
  upstreamToolResult: MessagesToolResultBlock;
  searchResultOwnership: SearchResultOwnership[];
}

interface ReplayAwareMessagesWebSearchShimState {
  priorSearchUseCount: number;
  requestSearchResultOwnership: SearchResultOwnership[];
}

interface ActiveMessagesWebSearchProvider {
  providerName: WebSearchProviderName;
  impl: WebSearchProvider;
  apiKeyId: string;
}

export type MessagesWebSearchShimState =
  | {
    mode: 'inactive';
  }
  | ({
    mode: 'replay_only';
  } & ReplayAwareMessagesWebSearchShimState)
  | ({
    mode: 'active';
    toolVersion: MessagesNativeWebSearchTool['type'];
    maxUses?: number;
    allowedDomains?: string[];
    blockedDomains?: string[];
    userLocation?: {
      city?: string;
      region?: string;
      country?: string;
      timezone?: string;
    };
  } & ReplayAwareMessagesWebSearchShimState);

export type PrepareMessagesWebSearchShimRequestResult =
  | {
    type: 'ok';
    payload: MessagesPayload;
    state: MessagesWebSearchShimState;
  }
  | {
    type: 'invalid-request';
    message: string;
  };

// Official Anthropic API exposes native web_search to the model with this
// description and query-only input schema, and requires the native tool name to
// be exactly `web_search` when present.
const UPSTREAM_WEB_SEARCH_TOOL_DEFINITION: MessagesClientTool = {
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

const isNativeWebSearchToolDefinition = (tool: MessagesTool): tool is MessagesNativeWebSearchTool => tool.type === 'web_search_20250305' || tool.type === 'web_search_20260209';

const messagesWebSearchErrorCodeSet = new Set<string>(MESSAGES_WEB_SEARCH_ERROR_CODES);

const isMessagesWebSearchErrorCode = (value: unknown): value is MessagesWebSearchErrorCode => typeof value === 'string' && messagesWebSearchErrorCodeSet.has(value);

const isWebSearchToolResultError = (value: unknown): value is MessagesWebSearchToolResultError =>
  isJsonObject(value) && value.type === 'web_search_tool_result_error' && isMessagesWebSearchErrorCode(value.error_code);

const toUpstreamToolUseId = (toolUseId: string): string => (toolUseId.startsWith('srvtoolu_') ? `toolu_${toolUseId.slice('srvtoolu_'.length)}` : toolUseId);

const toNativeServerToolUseId = (toolUseId: string): string => (toolUseId.startsWith('toolu_') ? `srvtoolu_${toolUseId.slice('toolu_'.length)}` : toolUseId);

const buildUpstreamSearchResultBlock = (result: MessagesWebSearchResultBlock, decoded: NonNullable<ReturnType<typeof decodeWebSearchResultPayload>>): MessagesSearchResultBlock => ({
  type: 'search_result',
  source: result.url,
  title: result.title,
  content: decoded.content,
  citations: { enabled: true },
});

const buildNativeWebSearchErrorResultBlock = (toolUseId: string, errorCode: MessagesWebSearchErrorCode): Extract<MessagesAssistantContentBlock, { type: 'web_search_tool_result' }> => ({
  type: 'web_search_tool_result',
  tool_use_id: toNativeServerToolUseId(toolUseId),
  content: { type: 'web_search_tool_result_error', error_code: errorCode },
  caller: { type: 'direct' },
});

const buildNativeWebSearchServerToolUseBlock = (toolUseId: string, query: string): Extract<MessagesAssistantContentBlock, { type: 'server_tool_use' }> => ({
  type: 'server_tool_use',
  id: toNativeServerToolUseId(toolUseId),
  name: WEB_SEARCH_TOOL_NAME,
  input: { query },
});

const buildNativeWebSearchResultBlock = (result: Extract<WebSearchProviderResult, { type: 'ok' }>['results'][number]): MessagesWebSearchResultBlock => ({
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
const collectOwnedReplayResultsByServerToolUseId = (content: MessagesAssistantContentBlock[]): Map<string, OwnedReplayToolResult> => {
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

const messageHasOwnedReplayMarkers = (message: MessagesMessage): boolean => {
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

const decodeOwnedReplayCitation = (citation: MessagesTextCitation): MessagesTextCitation => {
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

const decodeOwnedReplayToolResult = (block: Extract<MessagesAssistantContentBlock, { type: 'web_search_tool_result' }>): OwnedReplayToolResult | null => {
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

const collectForeignSearchResultOwnership = (content: string | MessagesUserContentBlock[]): SearchResultOwnership[] => {
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

interface PreparedMessagesWebSearchReplay {
  hasOwnedReplay: boolean;
  messages: MessagesMessage[];
  priorSearchUseCount: number;
  requestSearchResultOwnership: SearchResultOwnership[];
}

const prepareMessagesWebSearchReplay = (messages: MessagesMessage[]): PreparedMessagesWebSearchReplay => {
  const hasOwnedReplay = messages.some(messageHasOwnedReplayMarkers);
  const rewrittenMessages: MessagesMessage[] = [];
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
    // with `role: 'assistant'`, which would silently corrupt a
    // MessagesSystemMessage carrying MessagesTextBlock[] into an assistant
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

    const rewrittenContent = message.content.flatMap((block): MessagesAssistantContentBlock[] => {
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

const validateNativeWebSearchToolDefinitions = (payload: MessagesPayload): { type: 'ok'; nativeTool?: MessagesNativeWebSearchTool } | { type: 'invalid-request'; message: string } => {
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

const buildMessagesWebSearchShimState = (nativeTool: MessagesNativeWebSearchTool | undefined, replay: PreparedMessagesWebSearchReplay): MessagesWebSearchShimState => {
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

export const prepareMessagesWebSearchShimRequest = (payload: MessagesPayload): PrepareMessagesWebSearchShimRequestResult => {
  const validatedNativeTools = validateNativeWebSearchToolDefinitions(payload);
  if (validatedNativeTools.type !== 'ok') {
    return validatedNativeTools;
  }

  const replay = prepareMessagesWebSearchReplay(payload.messages);
  const state = buildMessagesWebSearchShimState(validatedNativeTools.nativeTool, replay);

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

const rewriteResponseCitationToNative = (citation: MessagesTextCitation, state: MessagesWebSearchShimState): MessagesTextCitation => {
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

const buildNativeWebSearchResultBlockFromProviderResult = (result: WebSearchProviderResult, toolUseId: string): Extract<MessagesAssistantContentBlock, { type: 'web_search_tool_result' }> => {
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

// Per-block sub-state captured while walking upstream content blocks. Messages
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
  event: Extract<MessagesStreamEvent, { type: 'content_block_start' }>,
  state: MessagesWebSearchShimState,
): Extract<MessagesStreamEvent, { type: 'content_block_start' }> => {
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
  event: Extract<MessagesStreamEvent, { type: 'content_block_delta' }>,
  state: MessagesWebSearchShimState,
): Extract<MessagesStreamEvent, { type: 'content_block_delta' }> => {
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

// Synthesised events use the canonical Messages SSE shape for `server_tool_use`
// and `web_search_tool_result` blocks (input baked into the start event, no
// `input_json_delta`) so downstream clients see the same bytes Anthropic would
// emit for native server tools.
const runWebSearchStopHandler = async function* (
  block: Extract<ActiveBlock, { kind: 'web-search-tool-use' }>,
  shimState: ShimStreamingState,
  state: Extract<MessagesWebSearchShimState, { mode: 'active' }>,
  provider: ActiveMessagesWebSearchProvider,
): AsyncGenerator<ProtocolFrame<MessagesStreamEvent>> {
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
      const providerResult = await searchWebAndRecordUsage({ provider: provider.impl, providerName: provider.providerName, keyId: provider.apiKeyId, request });
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

export const rewriteMessagesWebSearchEventsToNative = async function* (
  frames: AsyncIterable<ProtocolFrame<MessagesStreamEvent>>,
  state: MessagesWebSearchShimState,
  provider?: ActiveMessagesWebSearchProvider,
): AsyncGenerator<ProtocolFrame<MessagesStreamEvent>> {
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
        throw new Error('upstream Messages SSE interleaved content blocks; web-search shim cannot renumber.');
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
        throw new Error('upstream Messages SSE emitted content_block_delta without an open block.');
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
        throw new Error('upstream Messages SSE emitted content_block_stop without an open block.');
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

const buildSyntheticInvalidRequestUpstreamError = (message: string) => ({
  type: 'api-error' as const,
  source: 'gateway' as const,
  status: 400,
  headers: new Headers({ 'content-type': 'application/json' }),
  body: new TextEncoder().encode(
    JSON.stringify({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message,
      },
    }),
  ),
});

const resolveActiveMessagesWebSearchProvider = async (apiKeyId: string): Promise<{ type: 'ok'; provider: ActiveMessagesWebSearchProvider } | ReturnType<typeof internalErrorResult>> => {
  const searchConfig = await loadSearchConfig();
  const configuredProvider = resolveConfiguredWebSearchProvider(searchConfig);

  if (configuredProvider.type === 'enabled') {
    return {
      type: 'ok',
      provider: {
        providerName: configuredProvider.provider,
        impl: configuredProvider.impl,
        apiKeyId,
      },
    };
  }

  return internalErrorResult(
    500,
    toInternalDebugError(
      new Error(
        configuredProvider.type === 'disabled'
          ? 'Native Messages web search requires an enabled search provider.'
          : `Native Messages web search is missing the configured ${configuredProvider.provider} credential.`,
      ),
    ),
  );
};

/**
 * Anthropic exposes native `web_search_*` server tools, but non-Messages
 * targets cannot run Anthropic server tools. This shim rewrites the native tool
 * definition into an ordinary client `web_search` tool, executes each search
 * the model issues using the gateway's configured provider, and rewrites the
 * response back to the Anthropic native `server_tool_use` /
 * `web_search_tool_result` / `web_search_result_location` shape.
 *
 * The shim is unconditional for non-native Messages targets (Responses /
 * Chat Completions cannot carry Anthropic server tools), and gated by the
 * `messages-web-search-shim` flag for native Messages targets (the upstream
 * may or may not be able to serve web_search natively).
 */
export const withMessagesWebSearchShim: MessagesInterceptor = async (ctx, gatewayCtx, run) => {
  if (ctx.targetApi === 'messages' && !providerModelOf(ctx.candidate).enabledFlags.has('messages-web-search-shim')) return await run();

  const prepared = prepareMessagesWebSearchShimRequest(ctx.payload);

  if (prepared.type === 'invalid-request') {
    return buildSyntheticInvalidRequestUpstreamError(prepared.message);
  }

  if (prepared.state.mode === 'inactive') {
    return await run();
  }

  const provider = prepared.state.mode === 'active' ? await resolveActiveMessagesWebSearchProvider(gatewayCtx.apiKeyId) : { type: 'ok' as const, provider: undefined };
  if (provider.type !== 'ok') return provider;

  ctx.payload = prepared.payload;

  const result = await run();
  if (result.type !== 'events') return result;

  return {
    ...result,
    events: rewriteMessagesWebSearchEventsToNative(result.events, prepared.state, provider.provider),
  };
};
