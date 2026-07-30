import type { MessagesUsage, MessagesUsageIteration, MessagesUsageServerToolUse } from './usage.ts';

/**
 * Messages requires `max_tokens`, but the Chat Completions, Responses, and
 * Gemini sources may omit their output-token cap. When we translate one of
 * those sources to a Messages target, the data-plane prefers the model's
 * advertised `/models` output cap (`limits.max_output_tokens`); this
 * constant is the last-resort gateway policy default when both the source
 * payload and the model capability are silent.
 *
 * There is no single ecosystem standard catch-all value here: `new-api`
 * defaults Claude to `8192`, while `one-api` and LiteLLM use `4096`. We keep
 * `8192` to match the gateway's prior behavior. Native Messages requests are
 * untouched: their `max_tokens` is whatever the client sent.
 *
 * References:
 * - https://github.com/BerriAI/litellm/blob/e9e86ed956ba53d5192e10b75634fe0246e836a7/litellm/llms/anthropic/chat/transformation.py
 * - https://github.com/QuantumNous/new-api/blob/65b16547329625f619cf797ae1eb9b748525056c/setting/model_setting/claude.go
 * - https://github.com/songquanpeng/one-api/blob/8df4a2670b98266bd287c698243fff327d9748cf/relay/adaptor/anthropic/main.go
 */
export const MESSAGES_FALLBACK_MAX_TOKENS = 8192;

export type MessagesThinkingDisplay = 'omitted' | 'summarized' | 'full';

export interface MessagesPayload {
  model: string;
  messages: MessagesMessage[];
  max_tokens: number;
  system?: string | MessagesTextBlock[];
  metadata?: { user_id?: string };
  stop_sequences?: string[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  tools?: MessagesTool[];
  tool_choice?: {
    type: 'auto' | 'any' | 'tool' | 'none';
    name?: string;
  };
  thinking?: {
    type: 'enabled' | 'adaptive' | 'disabled';
    budget_tokens?: number;
    display?: MessagesThinkingDisplay;
  };
  output_config?: {
    effort?: string;
    // Anthropic structured outputs: `{ type: 'json_schema', schema }`. GA per
    // https://platform.claude.com/docs/en/build-with-claude/structured-outputs;
    // unlike OpenAI it has no `name` / `description` / `strict` subfields and
    // no `json_object` variant.
    format?: { type: 'json_schema'; schema: Record<string, unknown> };
  };
  service_tier?: 'auto' | 'standard_only' | (string & {});
  // https://docs.claude.com/en/build-with-claude/fast-mode — Fast Mode is
  // opt-in per request. Beta-only on the upstream wire (gated by
  // `anthropic-beta: fast-mode-2026-02-01`), but we expose the field at the
  // protocol layer because the gateway treats `speed: 'fast'` as the canonical
  // client signal regardless of which upstream serves it.
  speed?: 'standard' | 'fast' | (string & {});
}

export interface MessagesSearchResultLocationCitation {
  type: 'search_result_location';
  url: string;
  title: string;
  search_result_index: number;
  start_block_index: number;
  end_block_index: number;
  cited_text?: string;
}

export interface MessagesWebSearchResultLocation {
  type: 'web_search_result_location';
  url: string;
  title: string;
  encrypted_index: string;
  cited_text?: string;
}

export type MessagesTextCitation = MessagesSearchResultLocationCitation | MessagesWebSearchResultLocation;

// `cache_control` shape carried on every cache-anchored block. The default
// upstream cache TTL is 5 minutes; an explicit `ttl` switches between the
// two TTL tiers Anthropic supports under the
// `extended-cache-ttl-2025-04-11` beta. Senders that don't carry that beta
// should omit the field and accept the default.
export interface MessagesCacheControl {
  type: 'ephemeral';
  ttl?: '5m' | '1h';
}

export interface MessagesTextBlock {
  type: 'text';
  text: string;
  citations?: MessagesTextCitation[];
  cache_control?: MessagesCacheControl;
}

export interface MessagesImageBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
    data: string;
  };
  cache_control?: MessagesCacheControl;
}

export interface MessagesSearchResultBlock {
  type: 'search_result';
  source: string;
  title: string;
  content: MessagesTextBlock[];
  citations?: { enabled: boolean };
}

export interface MessagesWebSearchResultBlock {
  type: 'web_search_result';
  url: string;
  title: string;
  encrypted_content: string;
  page_age?: string;
}

export type MessagesToolResultContentBlock = MessagesTextBlock | MessagesImageBlock | MessagesSearchResultBlock;

export interface MessagesToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | MessagesToolResultContentBlock[];
  is_error?: boolean;
  cache_control?: MessagesCacheControl;
}

export interface MessagesToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  caller?: { type: 'direct' };
  cache_control?: MessagesCacheControl;
}

export interface MessagesServerToolUseBlock {
  type: 'server_tool_use';
  id: string;
  name: string;
  input: { query: string };
}

export const MESSAGES_WEB_SEARCH_ERROR_CODES = ['too_many_requests', 'invalid_tool_input', 'max_uses_exceeded', 'query_too_long', 'request_too_large', 'unavailable'] as const;

export type MessagesWebSearchErrorCode = (typeof MESSAGES_WEB_SEARCH_ERROR_CODES)[number];

export interface MessagesWebSearchToolResultError {
  type: 'web_search_tool_result_error';
  error_code: MessagesWebSearchErrorCode;
}

export interface MessagesWebSearchToolResultBlock {
  type: 'web_search_tool_result';
  tool_use_id: string;
  content: MessagesWebSearchResultBlock[] | MessagesWebSearchToolResultError;
  caller?: { type: 'direct' };
}

export interface MessagesThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature?: string;
}

export interface MessagesRedactedThinkingBlock {
  type: 'redacted_thinking';
  data: string;
}

// Anthropic classifier refusal categories. The wire is versioned additively,
// so retain the open-string arm for categories introduced after this snapshot.
// https://github.com/anthropics/anthropic-sdk-typescript/blob/3b45cd3b69c956ac63384fdb09ce1d8109f3fa80/src/resources/messages/messages.ts#L1458-L1491
export type MessagesRefusalCategory =
  | 'cyber'
  | 'bio'
  | 'frontier_llm'
  | 'reasoning_extraction'
  | 'general_harms'
  | (string & {})
  | null;

export interface MessagesRefusalStopDetails {
  type: 'refusal';
  category: MessagesRefusalCategory;
  explanation: string | null;
  fallback_credit_token?: string | null;
  fallback_has_prefill_claim?: boolean | null;
  recommended_model?: string | null;
}

// Server-side refusal fallback boundary. It is a regular content block with
// no deltas and must survive assistant-history round trips in its original
// position.
// https://github.com/anthropics/anthropic-sdk-typescript/blob/3b45cd3b69c956ac63384fdb09ce1d8109f3fa80/src/resources/beta/messages/messages.ts#L1566-L1633
export interface MessagesFallbackBlock {
  type: 'fallback';
  from: { model: string };
  to: { model: string };
  trigger: {
    type: 'refusal';
    category: MessagesRefusalCategory;
  };
}

export interface MessagesFallbackBlockParam {
  type: 'fallback';
  from: { model: string };
  to: { model: string };
  trigger?: unknown;
}

export type MessagesUserContentBlock = MessagesTextBlock | MessagesImageBlock | MessagesToolResultBlock;

export type MessagesAssistantContentBlock =
  | MessagesTextBlock
  | MessagesToolUseBlock
  | MessagesServerToolUseBlock
  | MessagesWebSearchToolResultBlock
  | MessagesThinkingBlock
  | MessagesRedactedThinkingBlock
  | MessagesFallbackBlock;

export type MessagesAssistantInputContentBlock =
  | Exclude<MessagesAssistantContentBlock, MessagesFallbackBlock>
  | MessagesFallbackBlockParam;

export interface MessagesUserMessage {
  role: 'user';
  content: string | MessagesUserContentBlock[];
}

export interface MessagesAssistantMessage {
  role: 'assistant';
  content: string | MessagesAssistantInputContentBlock[];
}

// The Anthropic Messages API role enum is "user" | "assistant" | "system"
// (https://platform.claude.com/docs/en/api/messages). The docs prose has a
// stale line saying "there is no system role for input messages", but the
// schema and live behavior (Claude Code 2.1.154+ ships these and the
// Anthropic backend accepts them) include role: "system". Honor the schema.
export interface MessagesSystemMessage {
  role: 'system';
  content: string | MessagesTextBlock[];
}

export type MessagesMessage = MessagesUserMessage | MessagesAssistantMessage | MessagesSystemMessage;

export interface MessagesClientTool {
  type?: 'custom';
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
  strict?: boolean;
  cache_control?: MessagesCacheControl;
}

export interface MessagesNativeWebSearchTool {
  type: 'web_search_20250305' | 'web_search_20260209' | 'web_search_20260318';
  name?: string;
  max_uses?: number;
  allowed_domains?: string[];
  blocked_domains?: string[];
  user_location?: {
    type: 'approximate';
    city?: string;
    region?: string;
    country?: string;
    timezone?: string;
  };
}

export type MessagesTool = MessagesClientTool | MessagesNativeWebSearchTool;

export {
  mergeMessagesUsageSnapshot,
  messagesUsageSnapshot,
  splitMessagesCacheCreationTokens,
  type MessagesCacheCreationUsage,
  type MessagesUsage,
  type MessagesUsageIteration,
  type MessagesUsageServerToolUse,
  type MessagesUsageSnapshot,
} from './usage.ts';

export interface MessagesResult {
  id: string;
  type: 'message';
  role: 'assistant';
  content: MessagesAssistantContentBlock[];
  model: string;
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | 'pause_turn' | 'refusal' | null;
  stop_details?: MessagesRefusalStopDetails | null;
  stop_sequence: string | null;
  usage: MessagesUsage;
}

export type MessagesStreamEvent =
  | MessagesMessageStartEvent
  | MessagesContentBlockStartEvent
  | MessagesContentBlockDeltaEvent
  | MessagesContentBlockStopEvent
  | MessagesMessageDeltaEvent
  | MessagesMessageStopEvent
  | MessagesPingEvent
  | MessagesErrorEvent;

export interface MessagesMessageStartEvent {
  type: 'message_start';
  message: Omit<MessagesResult, 'content' | 'stop_reason' | 'stop_sequence'> & {
    content: [];
    stop_reason: null;
    stop_sequence: null;
  };
}

export interface MessagesContentBlockStartEvent {
  type: 'content_block_start';
  index: number;
  content_block:
    | { type: 'text'; text: string; citations?: MessagesTextCitation[] }
    | (Omit<MessagesToolUseBlock, 'input'> & {
      input: Record<string, unknown>;
    })
    | MessagesServerToolUseBlock
    | MessagesWebSearchToolResultBlock
    | { type: 'thinking'; thinking: string }
    | { type: 'redacted_thinking'; data: string }
    | MessagesFallbackBlock;
}

export interface MessagesContentBlockDeltaEvent {
  type: 'content_block_delta';
  index: number;
  delta:
    | { type: 'text_delta'; text: string; citations?: MessagesTextCitation[] }
    | { type: 'citations_delta'; citation: MessagesTextCitation }
    | { type: 'input_json_delta'; partial_json: string }
    | { type: 'thinking_delta'; thinking: string }
    | { type: 'signature_delta'; signature: string };
}

export interface MessagesContentBlockStopEvent {
  type: 'content_block_stop';
  index: number;
}

export interface MessagesMessageDeltaEvent {
  type: 'message_delta';
  delta: {
    stop_reason?: MessagesResult['stop_reason'];
    stop_details?: MessagesRefusalStopDetails | null;
    stop_sequence?: string | null;
  };
  usage?: {
    input_tokens?: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation?: {
      ephemeral_5m_input_tokens?: number;
      ephemeral_1h_input_tokens?: number;
    };
    output_tokens_details?: { thinking_tokens: number };
    service_tier?: 'standard' | 'priority' | 'batch' | (string & {});
    speed?: 'standard' | 'fast' | (string & {});
    server_tool_use?: MessagesUsageServerToolUse;
    iterations?: MessagesUsageIteration[] | null;
  };
}

interface MessagesMessageStopEvent {
  type: 'message_stop';
}

interface MessagesPingEvent {
  type: 'ping';
}

export interface MessagesErrorEvent {
  type: 'error';
  error: {
    type: string;
    message: string;
    name?: string;
    stack?: string;
    cause?: unknown;
    target_api?: string;
  };
}

export { parseMessagesStream, type ParseMessagesStreamOptions } from './stream.ts';

// Parse an inbound `anthropic-beta` header into the comma-separated beta
// slice that variant selection and policy filters consume. Returns an empty
// array for a null/empty header so callers can `.includes(...)` without an
// extra guard.
export const parseAnthropicBetaHeader = (raw: string | null | undefined): readonly string[] =>
  raw ? raw.split(',').map(part => part.trim()).filter(part => part.length > 0) : [];

export { MESSAGES_MISSING_TERMINAL_MESSAGE, collectMessagesProtocolEventsToResult } from './to-result.ts';
export { reassembleMessagesEvents } from './reassemble.ts';
export { messagesProtocolFrameToSSEFrame } from './to-sse.ts';
export { PROMPT_TOO_LONG_MESSAGE, buildPromptTooLongBody } from './context-window-error.ts';
