/**
 * Messages requires `max_tokens`, but the Chat Completions, Responses, and
 * Gemini sources may omit their output-token cap. When we translate one of
 * those sources to a Messages target, the data-plane prefers the model's
 * advertised `/models` output cap (`capabilities.maxOutputTokens`); this
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
  output_config?: { effort?: string };
  service_tier?: 'auto' | 'standard_only';
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

export interface MessagesTextBlock {
  type: 'text';
  text: string;
  citations?: MessagesTextCitation[];
}

export interface MessagesImageBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
    data: string;
  };
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
}

export interface MessagesToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  caller?: { type: 'direct' };
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

export type MessagesUserContentBlock = MessagesTextBlock | MessagesImageBlock | MessagesToolResultBlock;

export type MessagesAssistantContentBlock =
  | MessagesTextBlock
  | MessagesToolUseBlock
  | MessagesServerToolUseBlock
  | MessagesWebSearchToolResultBlock
  | MessagesThinkingBlock
  | MessagesRedactedThinkingBlock;

export interface MessagesUserMessage {
  role: 'user';
  content: string | MessagesUserContentBlock[];
}

export interface MessagesAssistantMessage {
  role: 'assistant';
  content: string | MessagesAssistantContentBlock[];
}

export type MessagesMessage = MessagesUserMessage | MessagesAssistantMessage;

export interface MessagesClientTool {
  type?: 'custom';
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
  strict?: boolean;
}

export interface MessagesNativeWebSearchTool {
  type: 'web_search_20250305' | 'web_search_20260209';
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

export interface MessagesUsageServerToolUse {
  web_search_requests?: number;
}

export interface MessagesUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  service_tier?: 'standard' | 'priority' | 'batch';
  server_tool_use?: MessagesUsageServerToolUse;
}

export interface MessagesResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: MessagesAssistantContentBlock[];
  model: string;
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | 'pause_turn' | 'refusal' | null;
  stop_sequence: string | null;
  usage: MessagesUsage;
}

export type MessagesStreamEventData =
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
  message: Omit<MessagesResponse, 'content' | 'stop_reason' | 'stop_sequence'> & {
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
    | { type: 'redacted_thinking'; data: string };
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
    stop_reason?: MessagesResponse['stop_reason'];
    stop_sequence?: string | null;
  };
  usage?: {
    input_tokens?: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    server_tool_use?: MessagesUsageServerToolUse;
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
    source_api?: string;
    target_api?: string;
  };
}
