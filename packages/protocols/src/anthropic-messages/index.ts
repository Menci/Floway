import type { ANTHROPIC_MESSAGES_WEB_SEARCH_ERROR_CODES } from './constants.ts';
import type * as Beta from './sdk-beta.ts';
import type * as Native from './sdk-stable.ts';
import type { AnthropicMessagesUsage, AnthropicMessagesUsageDelta, AnthropicMessagesUsageDeltaEx } from './usage.ts';
import type { OpenWire } from '../common/open-wire.ts';

export { ANTHROPIC_MESSAGES_FALLBACK_MAX_TOKENS, ANTHROPIC_MESSAGES_WEB_SEARCH_ERROR_CODES } from './constants.ts';

// Additional caller metadata can be forwarded to protocols with string metadata maps.
export interface AnthropicMessagesMetadataEx extends Native.Metadata { [field: string]: unknown }
export type AnthropicMessagesThinkingConfig = OpenWire<Beta.BetaThinkingConfigParam>;
export type AnthropicMessagesThinkingDisplay = NonNullable<OpenWire<Beta.BetaThinkingConfigEnabled['display']>>;

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
  tool_choice?: OpenWire<Native.ToolChoice | Beta.BetaToolChoice>;
  thinking?: AnthropicMessagesThinkingConfig;
  output_config?: OpenWire<Beta.BetaOutputConfig>;
  service_tier?: OpenWire<NonNullable<Native.MessageCreateParamsBase['service_tier']>>;
  // https://docs.claude.com/en/build-with-claude/fast-mode — Fast Mode is
  // opt-in per request. Beta-only on the upstream wire (gated by
  // `anthropic-beta: fast-mode-2026-02-01`), but we expose the field at the
  // protocol layer because the gateway treats `speed: 'fast'` as the canonical
  // client signal regardless of which upstream serves it.
  speed?: OpenWire<Beta.MessageCreateParamsBase['speed']>;
}

export type AnthropicMessagesCountTokensPayload = Omit<AnthropicMessagesPayload, 'max_tokens' | 'stream'>;
export { decodeAnthropicMessagesCountTokensResult, type AnthropicMessagesCountTokensResult } from './count-tokens.ts';

// Request citation parameters and output citations differ in nullable file metadata.
export type AnthropicMessagesSearchResultLocationCitation = OpenWire<Native.CitationsSearchResultLocation>;
export type AnthropicMessagesWebSearchResultLocation = OpenWire<Native.CitationsWebSearchResultLocation>;
export type AnthropicMessagesTextCitation = OpenWire<Native.TextCitation>;
export type AnthropicMessagesTextCitationParam = OpenWire<Native.TextCitationParam>;

// The default upstream cache TTL is 5 minutes; an explicit `ttl` switches
// between the two TTL tiers Anthropic supports under the
// `extended-cache-ttl-2025-04-11` beta. Senders that don't carry that beta
// should omit the field and accept the default.
export type AnthropicMessagesCacheControl = OpenWire<Native.CacheControlEphemeral>;

export type AnthropicMessagesTextBlock = OpenWire<Native.TextBlock>;
export type AnthropicMessagesTextBlockParam = OpenWire<Native.TextBlockParam>;
export type AnthropicMessagesImageBlock = OpenWire<Native.ImageBlockParam>;
export type AnthropicMessagesImageSource = AnthropicMessagesImageBlock['source'];

// The official snapshot pins a binary document's `media_type` to
// `'application/pdf'`. Floway keeps this extension open so translation can
// forward caller-provided MIME values for upstream validation without
// relabelling non-PDF bytes as PDF.
export type AnthropicMessagesDocumentBlockEx = {
  type: 'document';
  source: Omit<Extract<Native.DocumentBlockParam['source'], { type: 'base64' }>, 'media_type'> & { media_type: string };
  cache_control?: AnthropicMessagesCacheControl | null;
  citations?: Native.CitationsConfigParam | null;
  context?: string | null;
  title?: string | null;
};

export type AnthropicMessagesSearchResultBlock = OpenWire<Native.SearchResultBlockParam | Beta.BetaSearchResultBlockParam>;

export type AnthropicMessagesWebSearchResultBlock = OpenWire<Native.WebSearchResultBlock | Beta.BetaWebSearchResultBlock>;

type AnthropicMessagesNativeToolResultContentBlock = OpenWire<
  | Exclude<NonNullable<Native.ToolResultBlockParam['content']>, string>[number]
  | Exclude<NonNullable<Beta.BetaToolResultBlockParam['content']>, string>[number]
>;

export type AnthropicMessagesToolResultContentBlock = AnthropicMessagesNativeToolResultContentBlock | AnthropicMessagesDocumentBlockEx;

export type AnthropicMessagesToolResultBlockEx = Omit<OpenWire<Native.ToolResultBlockParam>, 'content'> & {
  content?: string | AnthropicMessagesToolResultContentBlock[];
};

export type AnthropicMessagesToolResultBlock = OpenWire<Native.ToolResultBlockParam | Beta.BetaToolResultBlockParam> | AnthropicMessagesToolResultBlockEx;

export type AnthropicMessagesToolUseBlock = OpenWire<Native.ToolUseBlock>;
export type AnthropicMessagesToolUseBlockParam = OpenWire<Native.ToolUseBlockParam | Beta.BetaToolUseBlockParam>;
export type AnthropicMessagesServerToolUseBlock = OpenWire<Native.ServerToolUseBlock>;
export type AnthropicMessagesServerToolUseBlockParam = OpenWire<Native.ServerToolUseBlockParam | Beta.BetaServerToolUseBlockParam>;

export type AnthropicMessagesWebSearchErrorCode = (typeof ANTHROPIC_MESSAGES_WEB_SEARCH_ERROR_CODES)[number];

export type AnthropicMessagesWebSearchToolResultError = Omit<OpenWire<Native.WebSearchToolResultError>, 'error_code'> & {
  error_code: AnthropicMessagesWebSearchErrorCode;
};

export type AnthropicMessagesWebSearchToolResultBlock = OpenWire<Native.WebSearchToolResultBlock | Beta.BetaWebSearchToolResultBlock>;
export type AnthropicMessagesWebSearchToolResultBlockParam = OpenWire<Native.WebSearchToolResultBlockParam | Beta.BetaWebSearchToolResultBlockParam>;

export type AnthropicMessagesThinkingBlock = OpenWire<Native.ThinkingBlock>;
export type AnthropicMessagesRedactedThinkingBlock = OpenWire<Native.RedactedThinkingBlock>;

// The beta stop details add fallback guidance the stable details omit.
export type AnthropicMessagesRefusalStopDetails = OpenWire<Native.RefusalStopDetails> & Partial<OpenWire<Omit<Beta.BetaRefusalStopDetails, keyof Native.RefusalStopDetails>>>;

export type AnthropicMessagesRefusalCategory = AnthropicMessagesRefusalStopDetails['category'];

export type AnthropicMessagesUserContentBlock = AnthropicMessagesInputContentBlock;

export type AnthropicMessagesAssistantContentBlock = OpenWire<Native.ContentBlock | Beta.BetaContentBlock>;
export type AnthropicMessagesAssistantInputContentBlock = OpenWire<Native.ContentBlockParam | Beta.BetaContentBlockParam>;
export type AnthropicMessagesInputContentBlock = AnthropicMessagesAssistantInputContentBlock | AnthropicMessagesDocumentBlockEx | AnthropicMessagesToolResultBlockEx;

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
  // Request diagnostics are `null` unless the request supplied them, so a stream that reports none may omit the field.
  // https://github.com/anthropics/anthropic-sdk-typescript/blob/d49bdab458000bcdffe77bd84b03293f31824fb3/src/resources/messages/messages.ts#L2559-L2563
  message: Omit<AnthropicMessagesResult, 'content' | 'stop_reason' | 'stop_sequence' | 'diagnostics'> & Partial<Pick<AnthropicMessagesResult, 'diagnostics'>> & {
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

export { decodeAnthropicMessagesStream, parseAnthropicMessagesStream, type ParseAnthropicMessagesStreamOptions } from './stream.ts';

// Parse an inbound `anthropic-beta` header into the comma-separated beta
// slice that variant selection and policy filters consume. Returns an empty
// array for a null/empty header so callers can `.includes(...)` without an
// extra guard.
export { parseAnthropicBetaHeader } from './beta-header.ts';

export { ANTHROPIC_MESSAGES_MISSING_TERMINAL_MESSAGE, collectAnthropicMessagesProtocolEventsToResult } from './to-result.ts';
export { generateAnthropicId } from './id.ts';
export { createAnthropicMessagesEventAccumulator, reassembleAnthropicMessagesEvents, type AnthropicMessagesEventAccumulator } from './reassemble.ts';
export { anthropicMessagesProtocolFrameToSSEFrame } from './to-sse.ts';
export { PROMPT_TOO_LONG_MESSAGE, buildPromptTooLongBody } from './context-window-error.ts';
