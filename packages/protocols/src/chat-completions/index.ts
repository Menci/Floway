// Chat Completions type definitions (subset needed for translation)

export interface ChatCompletionsPayload {
  model: string;
  messages: ChatCompletionsMessage[];
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
  // GPT-5-family response-length control. Native OpenAI Chat field.
  // Reference: https://platform.openai.com/docs/api-reference/chat/create
  verbosity?: string | null;
  prompt_cache_key?: string | null;
  safety_identifier?: string | null;
  service_tier?: 'default' | 'auto' | 'flex' | 'priority' | 'scale' | (string & {}) | null;
  tools?: ChatCompletionsTool[] | null;
  tool_choice?: 'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } } | null;
  /** Request usage stats in streaming responses */
  stream_options?: { include_usage: boolean } | null;
}

export interface ChatCompletionsTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    strict?: boolean;
  };
}

export interface ChatCompletionsMessage {
  role: 'user' | 'assistant' | 'system' | 'tool' | 'developer';
  content: string | ChatCompletionsContentPart[] | null;
  name?: string;
  tool_calls?: ChatCompletionsToolCall[];
  tool_call_id?: string;
  /** Human-readable reasoning text (thinking content) */
  reasoning_text?: string | null;
  /** Opaque reasoning token/signature for round-tripping */
  reasoning_opaque?: string | null;
  reasoning_items?: ChatCompletionsReasoningItem[] | null;
}

export interface ChatCompletionsReasoningItem {
  type: 'reasoning';
  id?: string;
  summary?: { type: 'summary_text'; text: string }[];
}

export interface ChatCompletionsToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type ChatCompletionsContentPart = ChatCompletionsTextPart | ChatCompletionsImagePart;

interface ChatCompletionsTextPart {
  type: 'text';
  text: string;
}

interface ChatCompletionsImagePart {
  type: 'image_url';
  image_url: { url: string; detail?: 'low' | 'high' | 'auto' };
}

// Response types

export interface ChatCompletionsResult {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: ChatCompletionsChoiceNonStreaming[];
  // https://platform.openai.com/docs/api-reference/chat/object
  service_tier?: 'default' | 'auto' | 'flex' | 'priority' | 'scale' | (string & {}) | null;
  system_fingerprint?: string | null;
  usage?: ChatCompletionsUsage;
}

export interface ChatCompletionsStreamEvent {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: ChatCompletionsChoiceStreaming[];
  service_tier?: 'default' | 'auto' | 'flex' | 'priority' | 'scale' | (string & {}) | null;
  system_fingerprint?: string | null;
  usage?: ChatCompletionsUsage;
}

interface ChatCompletionsUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_creation_input_tokens?: number };
  completion_tokens_details?: {
    accepted_prediction_tokens: number;
    rejected_prediction_tokens: number;
    reasoning_tokens?: number;
  };
}

export interface ChatCompletionsChoiceNonStreaming {
  index: number;
  message: {
    role: 'assistant';
    content: string | null;
    tool_calls?: ChatCompletionsToolCall[];
    reasoning_text?: string | null;
    reasoning_opaque?: string | null;
    reasoning_items?: ChatCompletionsReasoningItem[] | null;
  };
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter';
}

interface ChatCompletionsChoiceStreaming {
  index: number;
  delta: ChatCompletionsDelta;
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
}

export interface ChatCompletionsDelta {
  content?: string | null;
  role?: string;
  tool_calls?: {
    index: number;
    id?: string;
    type?: 'function';
    function?: { name?: string; arguments?: string };
  }[];
  /** Human-readable reasoning text delta */
  reasoning_text?: string | null;
  /** Opaque reasoning token/signature delta */
  reasoning_opaque?: string | null;
  reasoning_items?: ChatCompletionsReasoningItem[] | null;
}

export * from './errors.ts';

export { parseChatCompletionsStream, type ParseChatCompletionsStreamOptions } from './stream.ts';

export { CHAT_COMPLETIONS_MISSING_TERMINAL_MESSAGE, collectChatCompletionsProtocolEventsToResult } from './to-result.ts';
export { reassembleChatCompletionsEvents } from './reassemble.ts';
export { chatCompletionsProtocolFrameToSSEFrame } from './to-sse.ts';
