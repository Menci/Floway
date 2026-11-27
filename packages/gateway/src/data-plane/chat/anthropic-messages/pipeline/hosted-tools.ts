import { decodeBase64UrlJson, encodeBase64UrlJson } from '../../../../shared/base64url-json.ts';
import { isJsonObject } from '../../../../shared/json-helpers.ts';
import { localWebSearchOperation } from '../../../non-chat/local-web-search/index.ts';
import type { WebSearchBackendRequest, WebSearchBackendResult } from '../../../tools/web-search/types.ts';
import { defineStage } from '../../pipeline/facts.ts';
import type { Result } from '@floway-dev/pipeline';
import type {
  AnthropicMessagesAssistantContentBlock,
  AnthropicMessagesAssistantInputContentBlock,
  AnthropicMessagesClientTool,
  AnthropicMessagesMessage,
  AnthropicMessagesNativeWebSearchTool,
  AnthropicMessagesPayload,
  AnthropicMessagesSearchResultBlock,
  AnthropicMessagesStreamEventEx,
  AnthropicMessagesTextCitation, AnthropicMessagesTextCitationParam,
  AnthropicMessagesTool,
  AnthropicMessagesToolResultBlock,
  AnthropicMessagesUsageDelta,
  AnthropicMessagesUserContentBlock,
  AnthropicMessagesWebSearchErrorCode,
  AnthropicMessagesWebSearchResultBlock,
  AnthropicMessagesWebSearchToolResultError,
} from '@floway-dev/protocols/anthropic-messages';
import { ANTHROPIC_MESSAGES_WEB_SEARCH_ERROR_CODES } from '@floway-dev/protocols/anthropic-messages';
import { internalDebugErrorFields, toInternalDebugError, type ProtocolStreamError } from '@floway-dev/upstream';

const MAX_QUERY_LENGTH = 1000;
const MAX_SEARCH_BLOCK_BYTES = 1024 * 1024;
const MAX_INTERLEAVED_SEARCH_BYTES = 8 * 1024 * 1024;
const WEB_SEARCH_TOOL_NAME = 'web_search';

// vLLM v0.29.1rc0 models stream-event usage as optional and synthesizes zero
// counters when its underlying usage is absent. Preserve that wire compatibility
// before adding the shim-owned server-tool counters.
// https://github.com/vllm-project/vllm/blob/v0.29.1rc0/vllm/entrypoints/anthropic/protocol.py#L213-L231
// https://github.com/vllm-project/vllm/blob/v0.29.1rc0/vllm/entrypoints/anthropic/serving.py#L55-L91
const EMPTY_MESSAGES_USAGE_DELTA: AnthropicMessagesUsageDelta = {
  input_tokens: null,
  output_tokens: 0,
  cache_creation_input_tokens: null,
  cache_read_input_tokens: null,
  output_tokens_details: null,
  server_tool_use: null,
};

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

type Search = (request: WebSearchBackendRequest) => Promise<WebSearchBackendResult | { kind: 'abort'; cause: unknown }>;
type StreamItem = Result<AnthropicMessagesStreamEventEx, ProtocolStreamError>;
type WebSearchPayload = Pick<AnthropicMessagesPayload, 'messages' | 'tools'>;

const eventFrame = (value: AnthropicMessagesStreamEventEx): StreamItem => ({ ok: true, value });
const protocolFailure = (message: string): StreamItem => ({ ok: false, error: { kind: 'protocol', cause: new Error(message) } });

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
    maxUses: number | undefined;
    allowedDomains: string[] | undefined;
    blockedDomains: string[] | undefined;
    userLocation: WebSearchBackendRequest['userLocation'];
  } & ReplayAwareAnthropicMessagesWebSearchShimState);

type PrepareAnthropicMessagesWebSearchShimRequestResult<Payload> =
  | {
    type: 'ok';
    payload: Payload;
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

const buildUpstreamSearchResultBlock = (result: Pick<AnthropicMessagesWebSearchResultBlock, 'url' | 'title' | 'encrypted_content'>, decoded: NonNullable<ReturnType<typeof decodeWebSearchResultPayload>>): AnthropicMessagesSearchResultBlock => ({
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
  caller: { type: 'direct' },
  type: 'server_tool_use',
  id: toNativeServerToolUseId(toolUseId),
  name: WEB_SEARCH_TOOL_NAME,
  input: { query },
});

const buildNativeWebSearchResultBlock = (result: Extract<WebSearchBackendResult, { type: 'ok' }>['results'][number]): AnthropicMessagesWebSearchResultBlock => ({
  type: 'web_search_result',
  url: result.source,
  title: result.title,
  encrypted_content: encodeWebSearchResultPayload({
    content: result.content,
  }),
  page_age: result.pageAge ?? null,
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

const decodeOwnedReplayCitation = (citation: AnthropicMessagesTextCitationParam): AnthropicMessagesTextCitationParam => {
  if (citation.type !== 'web_search_result_location') {
    return citation;
  }

  const decoded = decodeWebSearchCitationPayload(citation.encrypted_index);
  if (!decoded) {
    return citation;
  }

  return {
    cited_text: '',
    type: 'search_result_location',
    source: citation.url,
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
    // with `role: 'assistant'`, which would silently corrupt a
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

const validateNativeWebSearchToolDefinitions = (payload: WebSearchPayload): { type: 'ok'; nativeTool?: AnthropicMessagesNativeWebSearchTool } | { type: 'invalid-request'; message: string } => {
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

  if (nativeTool && (payload.tools ?? []).some(tool => !isNativeWebSearchToolDefinition(tool) && 'name' in tool && tool.name === WEB_SEARCH_TOOL_NAME)) {
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
    maxUses: nativeTool.max_uses ?? undefined,
    allowedDomains: normalizeNonEmptyDomainList(nativeTool.allowed_domains ?? undefined),
    blockedDomains: normalizeNonEmptyDomainList(nativeTool.blocked_domains ?? undefined),
    userLocation: nativeTool.user_location
      ? {
          city: nativeTool.user_location.city ?? undefined,
          region: nativeTool.user_location.region ?? undefined,
          country: nativeTool.user_location.country ?? undefined,
          timezone: nativeTool.user_location.timezone ?? undefined,
        }
      : undefined,
    priorSearchUseCount: replay.priorSearchUseCount,
    requestSearchResultOwnership: replay.requestSearchResultOwnership,
  };
};

export const prepareAnthropicMessagesWebSearchShimRequest = <Payload extends WebSearchPayload>(payload: Payload): PrepareAnthropicMessagesWebSearchShimRequestResult<Payload> => {
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
    cited_text: '',
    type: 'web_search_result_location',
    url: citation.source,
    title: citation.title,
    encrypted_index: encodeWebSearchCitationPayload({
      search_result_index: citation.search_result_index,
      start_block_index: citation.start_block_index,
      end_block_index: citation.end_block_index,
    }),
    ...(citation.cited_text ? { cited_text: citation.cited_text } : {}),
  };
};

const buildNativeWebSearchResultBlockFromBackendResult = (result: WebSearchBackendResult, toolUseId: string): Extract<AnthropicMessagesAssistantContentBlock, { type: 'web_search_tool_result' }> => {
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

// Per-block sub-state captured while walking upstream content blocks. Translated
// Messages streams may keep an earlier block open across later block lifecycles.
type ActiveBlock =
  | { kind: 'passthrough'; downstreamIndex: number }
  | { kind: 'text'; downstreamIndex: number }
  | {
    kind: 'web-search-tool-use';
    upstreamToolUseId: string;
    serverToolUseIndex: number;
    resultIndex: number;
    inputJson: string;
    inputBytes: number;
  };

interface ShimStreamingState {
  downstreamIndexOffset: number;
  currentSearchUseCount: number;
  executedSearchCount: number;
  interceptedSearches: number;
  hasRemainingClientToolUse: boolean;
}

const rewriteContentBlockStartCitations = (
  event: Extract<AnthropicMessagesStreamEventEx, { type: 'content_block_start' }>,
  state: AnthropicMessagesWebSearchShimState,
): Extract<AnthropicMessagesStreamEventEx, { type: 'content_block_start' }> => {
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
  event: Extract<AnthropicMessagesStreamEventEx, { type: 'content_block_delta' }>,
  state: AnthropicMessagesWebSearchShimState,
): Extract<AnthropicMessagesStreamEventEx, { type: 'content_block_delta' }> => {
  if (event.delta.type === 'citations_delta') return {
    ...event,
    delta: { type: 'citations_delta', citation: rewriteResponseCitationToNative(event.delta.citation, state) },
  };
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
  search: Search,
): AsyncGenerator<StreamItem> {
  const parsedInput = (() => {
    if (block.inputJson === '') return null;
    try {
      const parsed = JSON.parse(block.inputJson);
      return isJsonObject(parsed) ? parsed : null;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
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

    const result = await search({
      query,
      allowedDomains: state.allowedDomains,
      blockedDomains: state.blockedDomains,
      userLocation: state.userLocation,
    });
    if ('kind' in result) return result;
    return buildNativeWebSearchResultBlockFromBackendResult(result, block.upstreamToolUseId);
  })();

  if ('kind' in resultBlock) {
    yield { ok: false, error: resultBlock };
    return;
  }

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
  frames: AsyncIterable<StreamItem>,
  state: AnthropicMessagesWebSearchShimState,
  search?: Search,
): AsyncGenerator<StreamItem> {
  if (state.mode === 'inactive') {
    yield* frames;
    return;
  }

  if (state.mode === 'active' && search === undefined) {
    throw new Error('Active messages web-search rewrite requires a provider.');
  }

  const shimState: ShimStreamingState = {
    downstreamIndexOffset: 0,
    currentSearchUseCount: state.priorSearchUseCount,
    executedSearchCount: 0,
    interceptedSearches: 0,
    hasRemainingClientToolUse: false,
  };

  const activeBlocks = new Map<number, ActiveBlock>();
  let activeWebSearchIndex: number | undefined;
  let deferredFrames: AnthropicMessagesStreamEventEx[] = [];
  let deferredBytes = 0;
  const encoder = new TextEncoder();

  const processFrame = async function* (
    event: AnthropicMessagesStreamEventEx,
  ): AsyncGenerator<StreamItem> {
    if (activeWebSearchIndex !== undefined) {
      const belongsToSearch = (event.type === 'content_block_delta' || event.type === 'content_block_stop')
        && event.index === activeWebSearchIndex;
      if (!belongsToSearch && event.type !== 'ping') {
        deferredBytes += encoder.encode(JSON.stringify(event)).byteLength;
        if (deferredBytes > MAX_INTERLEAVED_SEARCH_BYTES) throw new RangeError(`Interleaved Anthropic Messages web search exceeds ${MAX_INTERLEAVED_SEARCH_BYTES} bytes`);
        deferredFrames.push(event);
        return;
      }
    }

    if (event.type === 'content_block_start') {
      if (activeBlocks.has(event.index)) {
        yield protocolFailure(`Upstream Anthropic Messages SSE opened content block ${event.index} twice.`);
        return;
      }

      const downstreamBase = event.index + shimState.downstreamIndexOffset;

      if (state.mode === 'active' && event.content_block.type === 'tool_use' && event.content_block.name === WEB_SEARCH_TOOL_NAME) {
        activeBlocks.set(event.index, {
          kind: 'web-search-tool-use',
          upstreamToolUseId: event.content_block.id,
          serverToolUseIndex: downstreamBase,
          resultIndex: downstreamBase + 1,
          inputJson: '',
          inputBytes: 0,
        });
        activeWebSearchIndex = event.index;
        return;
      }

      if (event.content_block.type === 'text') {
        activeBlocks.set(event.index, { kind: 'text', downstreamIndex: downstreamBase });
        yield eventFrame({ ...rewriteContentBlockStartCitations(event, state), index: downstreamBase });
        return;
      }

      if (event.content_block.type === 'tool_use') {
        shimState.hasRemainingClientToolUse = true;
      }

      activeBlocks.set(event.index, { kind: 'passthrough', downstreamIndex: downstreamBase });
      yield eventFrame({ ...event, index: downstreamBase });
      return;
    }

    if (event.type === 'content_block_delta') {
      const activeBlock = activeBlocks.get(event.index);
      if (activeBlock === undefined) {
        yield protocolFailure(`Upstream Anthropic Messages SSE emitted content_block_delta for unopened block ${event.index}.`);
        return;
      }

      if (activeBlock.kind === 'web-search-tool-use') {
        if (event.delta.type === 'input_json_delta') {
          const inputBytes = activeBlock.inputBytes + encoder.encode(event.delta.partial_json).byteLength;
          if (inputBytes > MAX_SEARCH_BLOCK_BYTES) throw new RangeError(`Anthropic Messages web-search input exceeds ${MAX_SEARCH_BLOCK_BYTES} bytes`);
          activeBlocks.set(event.index, { ...activeBlock, inputBytes, inputJson: activeBlock.inputJson + event.delta.partial_json });
        }
        return;
      }

      if (activeBlock.kind === 'text') {
        yield eventFrame({ ...rewriteContentBlockDeltaCitations(event, state), index: activeBlock.downstreamIndex });
        return;
      }

      yield eventFrame({ ...event, index: activeBlock.downstreamIndex });
      return;
    }

    if (event.type === 'content_block_stop') {
      const activeBlock = activeBlocks.get(event.index);
      if (activeBlock === undefined) {
        yield protocolFailure(`Upstream Anthropic Messages SSE emitted content_block_stop for unopened block ${event.index}.`);
        return;
      }

      if (activeBlock.kind === 'web-search-tool-use') {
        if (state.mode !== 'active') {
          throw new Error('web-search shim entered intercept path without active state.');
        }

        yield* runWebSearchStopHandler(activeBlock, shimState, state, search!);
        activeBlocks.delete(event.index);
        activeWebSearchIndex = undefined;
        const resume = deferredFrames;
        deferredFrames = [];
        deferredBytes = 0;
        for (const deferred of resume) yield* processFrame(deferred);
        return;
      }

      yield eventFrame({ type: 'content_block_stop', index: activeBlock.downstreamIndex });
      activeBlocks.delete(event.index);
      return;
    }

    // Inject `usage.server_tool_use.web_search_requests` and flip `stop_reason`
    // so the downstream view matches what an upstream with native web_search
    // (Anthropic's own) would have produced.
    if (event.type === 'message_delta') {
      const interceptedAny = shimState.interceptedSearches > 0;
      const baseUsage = event.usage ?? EMPTY_MESSAGES_USAGE_DELTA;
      const newUsage = shimState.executedSearchCount > 0
        ? { ...baseUsage, server_tool_use: { web_search_requests: shimState.executedSearchCount, web_fetch_requests: baseUsage.server_tool_use?.web_fetch_requests ?? 0 } }
        : baseUsage;

      yield eventFrame({
        type: 'message_delta',
        delta: interceptedAny
          ? { ...event.delta, stop_reason: shimState.hasRemainingClientToolUse ? 'tool_use' : 'pause_turn' }
          : event.delta,
        usage: newUsage,
      });
      return;
    }

    yield eventFrame(event);
  };

  for await (const item of frames) {
    if (!item.ok) {
      yield item;
      return;
    }
    for await (const projected of processFrame(item.value)) {
      yield projected;
      if (!projected.ok) return;
    }
  }
  if (activeWebSearchIndex !== undefined || deferredFrames.length > 0) {
    yield protocolFailure('Intercepted web search ended before its content block closed.');
  }
};

export const anthropicMessagesWebSearchInvalidRequestBody = (message: string) => ({
  type: 'error',
  error: {
    type: 'invalid_request_error',
    message,
  },
});

const localError = (status: number, error: unknown) => ({
  http: { status, statusText: '', headers: [['content-type', 'application/json']] as [string, string][], body: null },
  'anthropicMessages': { kind: 'error' as const, source: 'local' as const, error },
});

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
export const anthropicMessagesHostedTools = defineStage({
  name: 'anthropicMessages.hosted-tools',
  through: {
    request: { needs: ['anthropicMessages', 'model', 'http', 'chat.target'], provides: ['anthropicMessages'], consumes: [] },
    response: { needs: ['http', 'anthropicMessages'], provides: ['anthropicMessages'], consumes: [] },
  },
  return: { provides: ['http', 'anthropicMessages'] },
  async execute(facts, scope) {
    const { model, anthropicMessages } = facts;
    if (facts['chat.target'] === 'anthropicMessages' && !model.enabledFlags.includes('anthropic-messages-web-search-shim')) return await scope.next(facts);
    const prepared = prepareAnthropicMessagesWebSearchShimRequest(anthropicMessages);
    if (prepared.type === 'invalid-request') return localError(400, anthropicMessagesWebSearchInvalidRequestBody(prepared.message));
    if (prepared.state.mode === 'inactive') return await scope.next(facts);
    if (prepared.state.mode === 'active') {
      const configured = await scope.services.localWebSearch.getBackend();
      if (configured.type !== 'enabled') {
        const message = configured.type === 'disabled'
          ? 'Native Anthropic Messages web search requires an enabled search backend.'
          : `Native Anthropic Messages web search is missing the configured ${configured.backend} credential.`;
        const error = toInternalDebugError(new Error(message));
        return localError(500, {
          type: 'error',
          error: {
            type: error.type,
            message: error.message,
            provider_specific_fields: internalDebugErrorFields(error),
          },
        });
      }
    }

    const answer = await scope.next({ ...facts, 'anthropicMessages': prepared.payload });
    const outcome = answer['anthropicMessages'];
    if (outcome.kind !== 'stream') return answer;
    const stream = scope.wrapStream(outcome.stream, async function* (inner, producer) {
      const search: Search = async query => {
        if (producer.signal.aborted) return { kind: 'abort', cause: producer.signal.reason };
        const call = producer.run(localWebSearchOperation, {
          http: { method: 'POST', url: new URL('/v1/alpha/search', facts.http.url).href, headers: [], body: null },
          'serve.startedAt': Date.now(),
          webSearch: { kind: 'provider', query },
        });
        const answer = await call.catch(error => { producer.abort(call); throw error; });
        try {
          const result = answer.webSearch;
          if (result.kind === 'abort') return result;
          if (result.kind !== 'provider') throw new TypeError('Expected an Anthropic Messages web search result');
          return result.result;
        } finally {
          producer.abort(call);
          producer.discard(answer);
        }
      };
      const cursor = producer.read(inner);
      let held = true;
      const source: AsyncIterable<StreamItem> = {
        [Symbol.asyncIterator]: () => ({
          async next() {
            const item = await cursor.next();
            if (item.done) held = false;
            return item;
          },
        }),
      };
      for await (const item of rewriteAnthropicMessagesWebSearchEventsToNative(source, prepared.state, search)) {
        if (!item.ok && held) producer.discard(inner);
        yield item;
        if (!item.ok) return;
      }
    });
    return { ...answer, 'anthropicMessages': { kind: 'stream', stream } };
  },
});
