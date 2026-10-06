import type * as Beta from './sdk-beta.ts';
import type * as Native from './sdk-stable.ts';
import type { AnthropicMessagesUsage, AnthropicMessagesUsageDelta, AnthropicMessagesUsageDeltaEx } from './usage.ts';

/**
 * Anthropic Messages requires `max_tokens`, but translated source protocols
 * and Claude Code-shaped clients may omit their output-token cap. Whenever
 * Floway must synthesize one, the data-plane prefers the model's advertised
 * `/models` output cap (`limits.max_output_tokens`); this constant is the
 * last-resort gateway policy when both the payload and model capability are
 * silent. The Playground uses the same value for its initial request budget.
 *
 * There is no single ecosystem standard catch-all value here: `new-api`
 * defaults Claude to `8192`, while `one-api` and LiteLLM use `4096`. Those
 * conservative values can stop modern Claude generations prematurely, so
 * Floway uses `32768`; this is a gateway policy, not an upstream default.
 * Explicit client values are preserved. Claude Code subscription requests
 * that omit the required field are completed from this policy so they reach
 * the upstream with a usable output budget.
 *
 * References:
 * - https://github.com/BerriAI/litellm/blob/e9e86ed956ba53d5192e10b75634fe0246e836a7/litellm/llms/anthropic/chat/transformation.py
 * - https://github.com/QuantumNous/new-api/blob/65b16547329625f619cf797ae1eb9b748525056c/setting/model_setting/claude.go
 * - https://github.com/songquanpeng/one-api/blob/8df4a2670b98266bd287c698243fff327d9748cf/relay/adaptor/anthropic/main.go
 */
export const ANTHROPIC_MESSAGES_FALLBACK_MAX_TOKENS = 32768;

export type AnthropicMessagesThinkingDisplay = 'omitted' | 'summarized' | 'updates' | (string & {});
// Additional caller metadata can be forwarded to protocols with string metadata maps.
export interface AnthropicMessagesMetadataEx extends Native.Metadata { [field: string]: unknown }
export type AnthropicMessagesThinkingConfig =
  | (Omit<Beta.BetaThinkingConfigEnabled, 'display'> & { display?: AnthropicMessagesThinkingDisplay | null })
  | (Omit<Beta.BetaThinkingConfigAdaptive, 'display'> & { display?: AnthropicMessagesThinkingDisplay | null })
  | Beta.BetaThinkingConfigDisabled
  | Beta.BetaThinkingConfigBetweenTools;

export interface AnthropicMessagesPayload extends Omit<Native.MessageCreateParamsBase & Beta.MessageCreateParamsBase, 'model' | 'messages' | 'max_tokens' | 'system' | 'metadata' | 'stop_sequences' | 'stream' | 'temperature' | 'top_p' | 'top_k' | 'tools' | 'tool_choice' | 'thinking' | 'output_config' | 'service_tier' | 'speed'> {
  model: string;
  messages: AnthropicMessagesMessage[];
  max_tokens: number;
  system?: string | AnthropicMessagesTextBlockParam[];
  metadata?: { user_id?: string | null };
  stop_sequences?: string[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  tools?: AnthropicMessagesTool[];
  tool_choice?: Native.ToolChoice | Beta.BetaToolChoice;
  thinking?: AnthropicMessagesThinkingConfig;
  output_config?: Omit<Beta.BetaOutputConfig, 'effort'> & { effort?: string | null };
  service_tier?: 'auto' | 'standard_only' | (string & {});
  // https://docs.claude.com/en/build-with-claude/fast-mode — Fast Mode is
  // opt-in per request. Beta-only on the upstream wire (gated by
  // `anthropic-beta: fast-mode-2026-02-01`), but we expose the field at the
  // protocol layer because the gateway treats `speed: 'fast'` as the canonical
  // client signal regardless of which upstream serves it.
  speed?: 'standard' | 'fast' | (string & {}) | null;
}

// Request citation parameters and output citations differ in nullable file metadata.
// https://github.com/anthropics/anthropic-sdk-typescript/blob/d49bdab458000bcdffe77bd84b03293f31824fb3/src/resources/messages/messages.ts#L1286-L1543
export interface AnthropicMessagesSearchResultLocationCitation { type: 'search_result_location'; source: string; title: string | null; search_result_index: number; start_block_index: number; end_block_index: number; cited_text: string }
export interface AnthropicMessagesWebSearchResultLocation { type: 'web_search_result_location'; url: string; title: string | null; encrypted_index: string; cited_text: string }
interface AnthropicMessagesDocumentCitation { document_index: number; document_title: string | null; file_id: string | null; cited_text: string }
export type AnthropicMessagesTextCitation =
  | AnthropicMessagesSearchResultLocationCitation | AnthropicMessagesWebSearchResultLocation
  | (AnthropicMessagesDocumentCitation & { type: 'char_location'; start_char_index: number; end_char_index: number })
  | (AnthropicMessagesDocumentCitation & { type: 'page_location'; start_page_number: number; end_page_number: number })
  | (AnthropicMessagesDocumentCitation & { type: 'content_block_location'; start_block_index: number; end_block_index: number });
export type AnthropicMessagesTextCitationParam = AnthropicMessagesSearchResultLocationCitation | AnthropicMessagesWebSearchResultLocation
  | (Omit<AnthropicMessagesDocumentCitation, 'file_id'> & (
    { type: 'char_location'; start_char_index: number; end_char_index: number }
    | { type: 'page_location'; start_page_number: number; end_page_number: number }
    | { type: 'content_block_location'; start_block_index: number; end_block_index: number }
  ));

// `cache_control` shape carried on every cache-anchored block. The default
// upstream cache TTL is 5 minutes; an explicit `ttl` switches between the
// two TTL tiers Anthropic supports under the
// `extended-cache-ttl-2025-04-11` beta. Senders that don't carry that beta
// should omit the field and accept the default.
export interface AnthropicMessagesCacheControl {
  type: 'ephemeral';
  ttl?: '5m' | '1h';
}

export interface AnthropicMessagesTextBlock { type: 'text'; text: string; citations: AnthropicMessagesTextCitation[] | null }
export interface AnthropicMessagesTextBlockParam { type: 'text'; text: string; citations?: AnthropicMessagesTextCitationParam[] | null; cache_control?: AnthropicMessagesCacheControl | null }
export type AnthropicMessagesImageSource =
  | { type: 'base64'; media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'; data: string }
  | { type: 'url'; url: string }
  | { type: 'file'; file_id: string };
export interface AnthropicMessagesImageBlock { type: 'image'; source: AnthropicMessagesImageSource; cache_control?: AnthropicMessagesCacheControl | null; transformations?: { oversized_image?: 'downsize' | 'error' } | null }

export type AnthropicMessagesSearchResultBlock = Native.SearchResultBlockParam | Beta.BetaSearchResultBlockParam;

export type AnthropicMessagesWebSearchResultBlock = Native.WebSearchResultBlock | Beta.BetaWebSearchResultBlock;

export type AnthropicMessagesToolResultContentBlock = Exclude<NonNullable<AnthropicMessagesToolResultBlock['content']>, string>[number];

export type AnthropicMessagesToolResultBlock = Native.ToolResultBlockParam | Beta.BetaToolResultBlockParam;

export type AnthropicMessagesToolUseBlock = Native.ToolUseBlock;
export type AnthropicMessagesToolUseBlockParam = Native.ToolUseBlockParam | Beta.BetaToolUseBlockParam;
export type AnthropicMessagesServerToolUseBlock = Native.ServerToolUseBlock;
export type AnthropicMessagesServerToolUseBlockParam = Native.ServerToolUseBlockParam | Beta.BetaServerToolUseBlockParam;

export const ANTHROPIC_MESSAGES_WEB_SEARCH_ERROR_CODES = ['too_many_requests', 'invalid_tool_input', 'max_uses_exceeded', 'query_too_long', 'request_too_large', 'unavailable'] as const;

export type AnthropicMessagesWebSearchErrorCode = (typeof ANTHROPIC_MESSAGES_WEB_SEARCH_ERROR_CODES)[number];

export interface AnthropicMessagesWebSearchToolResultError {
  type: 'web_search_tool_result_error';
  error_code: AnthropicMessagesWebSearchErrorCode;
}

export type AnthropicMessagesWebSearchToolResultBlock = Native.WebSearchToolResultBlock | Beta.BetaWebSearchToolResultBlock;
export type AnthropicMessagesWebSearchToolResultBlockParam = Native.WebSearchToolResultBlockParam | Beta.BetaWebSearchToolResultBlockParam;

export interface AnthropicMessagesThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature: string;
}

export interface AnthropicMessagesRedactedThinkingBlock {
  type: 'redacted_thinking';
  data: string;
}

// Anthropic classifier refusal categories. The wire is versioned additively,
// so retain the open-string arm for categories introduced after this snapshot.
// https://github.com/anthropics/anthropic-sdk-typescript/blob/3b45cd3b69c956ac63384fdb09ce1d8109f3fa80/src/resources/messages/messages.ts#L1458-L1491
export type AnthropicMessagesRefusalCategory =
  | 'cyber'
  | 'bio'
  | 'frontier_llm'
  | 'reasoning_extraction'
  | 'general_harms'
  | (string & {})
  | null;

export interface AnthropicMessagesRefusalStopDetails {
  type: 'refusal';
  category: AnthropicMessagesRefusalCategory;
  explanation: string | null;
  fallback_credit_token?: string | null;
  fallback_has_prefill_claim?: boolean | null;
  recommended_model?: string | null;
}

export type AnthropicMessagesUserContentBlock = AnthropicMessagesInputContentBlock;

export type AnthropicMessagesAssistantContentBlock = Native.ContentBlock | Beta.BetaContentBlock;
export type AnthropicMessagesAssistantInputContentBlock = Native.ContentBlockParam | Beta.BetaContentBlockParam;
export type AnthropicMessagesInputContentBlock = AnthropicMessagesAssistantInputContentBlock;

export interface AnthropicMessagesUserMessage extends Omit<Beta.BetaMessageParam, 'role' | 'content'> {
  role: 'user';
  content: string | AnthropicMessagesUserContentBlock[];
}

export interface AnthropicMessagesAssistantMessage extends Omit<Beta.BetaMessageParam, 'role' | 'content'> {
  role: 'assistant';
  content: string | AnthropicMessagesAssistantInputContentBlock[];
}

// The Anthropic Messages API role enum is "user" | "assistant" | "system"
// (https://platform.claude.com/docs/en/api/messages). The docs prose has a
// stale line saying "there is no system role for input messages", but the
// schema and live behavior (Claude Code 2.1.154+ ships these and the
// Anthropic backend accepts them) include role: "system". Honor the schema.
export interface AnthropicMessagesSystemMessage extends Omit<Beta.BetaMessageParam, 'role' | 'content'> {
  role: 'system';
  content: string | AnthropicMessagesInputContentBlock[];
}

export type AnthropicMessagesMessage = AnthropicMessagesUserMessage | AnthropicMessagesAssistantMessage | AnthropicMessagesSystemMessage;

export interface AnthropicMessagesClientTool {
  type?: 'custom' | null;
  name: string;
  description?: string;
  input_schema: Native.Tool.InputSchema;
  strict?: boolean;
  allowed_callers?: string[];
  defer_loading?: boolean;
  eager_input_streaming?: boolean | null;
  input_examples?: Record<string, unknown>[];
  cache_control?: AnthropicMessagesCacheControl | null;
}

type NativeWebSearchTool = Native.WebSearchTool20250305 | Native.WebSearchTool20260209 | Native.WebSearchTool20260318 | Beta.BetaWebSearchTool20250305 | Beta.BetaWebSearchTool20260209 | Beta.BetaWebSearchTool20260318;
export type AnthropicMessagesNativeWebSearchTool = NativeWebSearchTool extends infer Tool ? Tool extends NativeWebSearchTool ? Omit<Tool, 'name' | 'allowed_callers'> & { name: string; allowed_callers?: string[] } : never : never;

export type AnthropicMessagesNativeTool = Exclude<Native.ToolUnion, Native.Tool | Native.WebSearchTool20250305 | Native.WebSearchTool20260209 | Native.WebSearchTool20260318> | Exclude<Beta.BetaToolUnion, Beta.BetaTool | Beta.BetaWebSearchTool20250305 | Beta.BetaWebSearchTool20260209 | Beta.BetaWebSearchTool20260318>;
export type AnthropicMessagesTool = AnthropicMessagesClientTool | AnthropicMessagesNativeWebSearchTool | AnthropicMessagesNativeTool;

export { createAnthropicMessagesUsage, toAnthropicMessagesUsageDelta, toAnthropicMessagesUsageDeltaEx, mergeAnthropicMessagesUsageSnapshot, anthropicMessagesUsageSnapshot, splitAnthropicMessagesCacheCreationTokens, type AnthropicMessagesCacheCreationUsage, type AnthropicMessagesUsage, type AnthropicMessagesUsageDelta, type AnthropicMessagesUsageDeltaEx, type AnthropicMessagesUsageIteration, type AnthropicMessagesUsageSnapshot } from './usage.ts';
export interface AnthropicMessagesResult extends Omit<Native.Message, 'content' | 'usage' | 'model' | 'stop_reason' | 'stop_details' | 'container'>, Partial<Pick<Beta.BetaMessage, 'context_management' | 'input_transformations'>> {
  id: string;
  type: 'message';
  role: 'assistant';
  content: AnthropicMessagesAssistantContentBlock[];
  model: string;
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | 'pause_turn' | 'refusal' | 'model_context_window_exceeded' | 'compaction' | null;
  stop_details: AnthropicMessagesRefusalStopDetails | null;
  container: Native.Container | Beta.BetaContainer | null;
  stop_sequence: string | null;
  usage: AnthropicMessagesUsage;
}

export type AnthropicMessagesStreamEventEx =
  | AnthropicMessagesMessageStartEvent
  | AnthropicMessagesContentBlockStartEvent
  | AnthropicMessagesContentBlockDeltaEvent
  | AnthropicMessagesContentBlockStopEvent
  | AnthropicMessagesMessageDeltaEventEx
  | AnthropicMessagesMessageStopEvent
  | AnthropicMessagesPingEvent
  | AnthropicMessagesErrorEventEx;
export interface AnthropicMessagesMessageStartEvent {
  type: 'message_start';
  message: Omit<AnthropicMessagesResult, 'content' | 'stop_reason' | 'stop_sequence'> & {
    content: [];
    stop_reason: null;
    stop_sequence: null;
  };
}

export interface AnthropicMessagesContentBlockStartEvent {
  type: 'content_block_start';
  index: number;
  content_block: AnthropicMessagesAssistantContentBlock;
}
export interface AnthropicMessagesContentBlockDeltaEvent {
  type: 'content_block_delta';
  index: number;
  delta:
    | { type: 'text_delta'; text: string }
    | { type: 'citations_delta'; citation: AnthropicMessagesTextCitation }
    | { type: 'input_json_delta'; partial_json: string }
    | { type: 'thinking_delta'; thinking: string; estimated_tokens?: number | null }
    | { type: 'signature_delta'; signature: string }
    | { type: 'compaction_delta'; content: string | null; encrypted_content?: string | null };
}

export interface AnthropicMessagesContentBlockStopEvent {
  type: 'content_block_stop';
  index: number;
}
export interface AnthropicMessagesMessageDeltaEvent {
  type: 'message_delta';
  delta: {
    container: Native.Container | Beta.BetaContainer | null;
    stop_reason: AnthropicMessagesResult['stop_reason'];
    stop_details: AnthropicMessagesRefusalStopDetails | null;
    stop_sequence: string | null;
  };
  context_management?: Beta.BetaContextManagementResponse | null;
  input_transformations?: Beta.BetaInputTransformation[] | null;
  usage: AnthropicMessagesUsageDelta;
}

export interface AnthropicMessagesMessageDeltaEventEx extends AnthropicMessagesMessageDeltaEvent {
  usage: AnthropicMessagesUsageDeltaEx;
}

interface AnthropicMessagesMessageStopEvent {
  type: 'message_stop';
}

interface AnthropicMessagesPingEvent {
  type: 'ping';
}

// Floway uses a LiteLLM-inspired namespace for structured internal diagnostics.
// https://github.com/BerriAI/litellm/blob/cad87a900fbe8b99eba258e6ebb23f58225a8002/litellm/proxy/common_request_processing.py#L943-L975
export interface AnthropicMessagesErrorEventEx {
  type: 'error';
  error: {
    type: string;
    message: string;
    provider_specific_fields?: Record<string, unknown>;
  };
}

export { parseAnthropicMessagesStream, type ParseAnthropicMessagesStreamOptions } from './stream.ts';

// Parse an inbound `anthropic-beta` header into the comma-separated beta
// slice that variant selection and policy filters consume. Returns an empty
// array for a null/empty header so callers can `.includes(...)` without an
// extra guard.
export const parseAnthropicBetaHeader = (raw: string | null | undefined): readonly string[] =>
  raw ? raw.split(',').map(part => part.trim()).filter(part => part.length > 0) : [];

export { ANTHROPIC_MESSAGES_MISSING_TERMINAL_MESSAGE, collectAnthropicMessagesProtocolEventsToResult } from './to-result.ts';
export { generateAnthropicId } from './id.ts';
export { reassembleAnthropicMessagesEvents } from './reassemble.ts';
export { anthropicMessagesProtocolFrameToSSEFrame } from './to-sse.ts';
export { PROMPT_TOO_LONG_MESSAGE, buildPromptTooLongBody } from './context-window-error.ts';
