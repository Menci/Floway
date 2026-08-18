// OpenAI Chat Completions type definitions (subset needed for translation)

export interface OpenAIChatCompletionsPayload {
  model: string;
  messages: OpenAIChatCompletionsMessage[];
  max_tokens?: number | null;
  stop?: string | string[] | null;
  stream?: boolean | null;
  temperature?: number | null;
  top_p?: number | null;
  n?: number | null;
  seed?: number | null;
  presence_penalty?: number | null;
  frequency_penalty?: number | null;
  user?: string | null;
  metadata?: Record<string, unknown> | null;
  store?: boolean | null;
  parallel_tool_calls?: boolean | null;
  response_format?: Record<string, unknown> | null;
  reasoning_effort?: string | null;
  // GPT-5-family response-length control. Native OpenAI Chat Completions field.
  // Reference: https://platform.openai.com/docs/api-reference/chat/create
  verbosity?: string | null;
  prompt_cache_key?: string | null;
  safety_identifier?: string | null;
  service_tier?: 'default' | 'auto' | 'flex' | 'priority' | 'scale' | (string & {}) | null;
  tools?: OpenAIChatCompletionsTool[] | null;
  tool_choice?: 'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } } | null;
  /** Request usage stats in streaming responses */
  stream_options?: { include_usage: boolean } | null;
}

export interface OpenAIChatCompletionsTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    strict?: boolean;
  };
}

export interface OpenAIChatCompletionsMessage {
  role: 'user' | 'assistant' | 'system' | 'tool' | 'developer';
  content: string | OpenAIChatCompletionsContentPart[] | null;
  name?: string;
  tool_calls?: OpenAIChatCompletionsToolCall[];
  tool_call_id?: string;
  /** Human-readable reasoning text (thinking content) */
  reasoning_text?: string | null;
  /** Opaque reasoning token/signature for round-tripping */
  reasoning_opaque?: string | null;
  reasoning_items?: OpenAIChatCompletionsReasoningItem[] | null;
  refusal?: string | null;
}

export interface OpenAIChatCompletionsReasoningItem {
  type: 'reasoning';
  id?: string;
  summary?: { type: 'summary_text'; text: string }[];
}

export interface OpenAIChatCompletionsToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type OpenAIChatCompletionsContentPart = OpenAIChatCompletionsTextPart | OpenAIChatCompletionsImagePart | OpenAIChatCompletionsRefusalPart;

interface OpenAIChatCompletionsTextPart {
  type: 'text';
  text: string;
}

interface OpenAIChatCompletionsImagePart {
  type: 'image_url';
  // OpenAI publishes `detail` as an optional `[auto, low, high]` string
  // defaulting to `auto`, with no null member. The value is open here because
  // the upstream owns the accept decision, and the absent case is the only one
  // whose meaning the protocol itself fixes.
  // https://github.com/openai/openai-openapi/blob/db3e53198a66732cfe161339ea63bf36fc0137ad/openapi.yaml#L30795-L30803
  image_url: { url: string; detail?: 'low' | 'high' | 'auto' | (string & {}) };
}

interface OpenAIChatCompletionsRefusalPart {
  type: 'refusal';
  refusal: string;
}

// Response types

export interface OpenAIChatCompletionsResult {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: OpenAIChatCompletionsChoiceNonStreaming[];
  // https://platform.openai.com/docs/api-reference/chat/object
  service_tier?: 'default' | 'auto' | 'flex' | 'priority' | 'scale' | (string & {}) | null;
  system_fingerprint?: string | null;
  usage?: OpenAIChatCompletionsUsage;
}

export interface OpenAIChatCompletionsStreamEvent {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: OpenAIChatCompletionsChoiceStreaming[];
  service_tier?: 'default' | 'auto' | 'flex' | 'priority' | 'scale' | (string & {}) | null;
  system_fingerprint?: string | null;
  usage?: OpenAIChatCompletionsUsage;
}

interface OpenAIChatCompletionsUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_creation_input_tokens?: number; cache_write_tokens?: number };
  completion_tokens_details?: {
    accepted_prediction_tokens: number;
    rejected_prediction_tokens: number;
    reasoning_tokens?: number;
  };
}

export interface OpenAIChatCompletionsChoiceNonStreaming {
  index: number;
  message: {
    role: 'assistant';
    content: string | null;
    tool_calls?: OpenAIChatCompletionsToolCall[];
    reasoning_text?: string | null;
    reasoning_opaque?: string | null;
    reasoning_items?: OpenAIChatCompletionsReasoningItem[] | null;
    refusal?: string | null;
  };
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter';
}

interface OpenAIChatCompletionsChoiceStreaming {
  index: number;
  delta: OpenAIChatCompletionsDelta;
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
}

export interface OpenAIChatCompletionsDelta {
  content?: string | null;
  role?: string;
  tool_calls?:
    | {
      index: number;
      id?: string;
      type?: 'function';
      function?: { name?: string; arguments?: string };
    }[]
    | null;
  /** Human-readable reasoning text delta */
  reasoning_text?: string | null;
  /** Opaque reasoning token/signature delta */
  reasoning_opaque?: string | null;
  reasoning_items?: OpenAIChatCompletionsReasoningItem[] | null;
  refusal?: string | null;
}

export * from './errors.ts';

export { parseOpenAIChatCompletionsStream, type ParseOpenAIChatCompletionsStreamOptions } from './stream.ts';

export { OPENAI_CHAT_COMPLETIONS_MISSING_TERMINAL_MESSAGE, collectOpenAIChatCompletionsProtocolEventsToResult } from './to-result.ts';
export { reassembleOpenAIChatCompletionsEvents } from './reassemble.ts';
export { openaiChatCompletionsProtocolFrameToSSEFrame } from './to-sse.ts';
