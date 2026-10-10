import type * as Official from './sdk.ts';

// Request, response and chunk shapes follow the official Chat Completions wire contracts.
// https://github.com/openai/openai-node/blob/7423ac3e9351c46300cd094479cded5551a72eb4/src/resources/chat/completions/completions.ts

export interface OpenAIChatCompletionsPayload extends Omit<Official.ChatCompletionCreateParamsBase, 'model' | 'messages' | 'audio' | 'frequency_penalty' | 'function_call' | 'functions' | 'logit_bias' | 'logprobs' | 'max_completion_tokens' | 'max_tokens' | 'metadata' | 'modalities' | 'n' | 'parallel_tool_calls' | 'prediction' | 'presence_penalty' | 'prompt_cache_key' | 'prompt_cache_options' | 'prompt_cache_retention' | 'reasoning_effort' | 'response_format' | 'safety_identifier' | 'seed' | 'service_tier' | 'stop' | 'store' | 'stream' | 'stream_options' | 'temperature' | 'tool_choice' | 'tools' | 'top_logprobs' | 'top_p' | 'user' | 'verbosity' | 'web_search_options'> {
  model: string;
  messages: OpenAIChatCompletionsMessage[];
  audio?: { format: 'wav' | 'aac' | 'mp3' | 'flac' | 'opus' | 'pcm16' | (string & {}); voice: string } | null;
  frequency_penalty?: number | null;
  function_call?: 'none' | 'auto' | { name: string };
  functions?: OpenAIChatCompletionsFunctionDefinition[];
  logit_bias?: Record<string, number> | null;
  logprobs?: boolean | null;
  max_completion_tokens?: number | null;
  max_tokens?: number | null;
  metadata?: Record<string, string> | null;
  modalities?: Array<'text' | 'audio' | (string & {})> | null;
  n?: number | null;
  parallel_tool_calls?: boolean;
  prediction?: { type: 'content'; content: string | OpenAIChatCompletionsTextPart[] } | null;
  presence_penalty?: number | null;
  prompt_cache_key?: string | null;
  prompt_cache_options?: { mode?: string; ttl?: string } | null;
  prompt_cache_retention?: 'in_memory' | '24h' | (string & {}) | null;
  reasoning_effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | (string & {}) | null;
  response_format?: OpenAIChatCompletionsResponseFormat;
  safety_identifier?: string | null;
  seed?: number | null;
  service_tier?: 'default' | 'auto' | 'flex' | 'priority' | 'scale' | (string & {}) | null;
  stop?: string | string[] | null;
  store?: boolean | null;
  stream?: boolean | null;
  stream_options?: OpenAIChatCompletionsStreamOptions | null;
  temperature?: number | null;
  tool_choice?: OpenAIChatCompletionsToolChoice;
  tools?: OpenAIChatCompletionsTool[];
  top_logprobs?: number | null;
  top_p?: number | null;
  user?: string | null;
  verbosity?: 'low' | 'medium' | 'high' | (string & {}) | null;
  web_search_options?: { search_context_size?: 'low' | 'medium' | 'high' | (string & {}); user_location?: { type: 'approximate'; approximate: { city?: string; country?: string; region?: string; timezone?: string } } | null };
}

export interface OpenAIChatCompletionsStreamOptions { include_obfuscation?: boolean; include_usage?: boolean }
export interface OpenAIChatCompletionsStreamOptionsEx extends OpenAIChatCompletionsStreamOptions {
  // vLLM/SGLang cumulative streaming usage extension.
  // https://github.com/vllm-project/vllm/blob/d5f0a6e829faa69d1db289bf62b14dae136c02b2/vllm/entrypoints/generate/base/protocol.py#L241-L243
  continuous_usage_stats?: boolean;
}

export interface OpenAIChatCompletionsPayloadEx extends OpenAIChatCompletionsPayload {
  stream_options?: OpenAIChatCompletionsStreamOptionsEx | null;
}

export interface OpenAIChatCompletionsFunctionDefinition { name: string; description?: string; parameters?: Record<string, unknown>; strict?: boolean | null }
export interface OpenAIChatCompletionsFunctionTool { type: 'function'; function: OpenAIChatCompletionsFunctionDefinition }
export interface OpenAIChatCompletionsCustomTool { type: 'custom'; custom: { name: string; description?: string; format?: { type: 'text' } | { type: 'grammar'; grammar: { definition: string; syntax: 'lark' | 'regex' | (string & {}) } } } }
export type OpenAIChatCompletionsTool = OpenAIChatCompletionsFunctionTool | OpenAIChatCompletionsCustomTool;
export type OpenAIChatCompletionsNamedToolChoice = { type: 'function'; function: { name: string } } | { type: 'custom'; custom: { name: string } };
export type OpenAIChatCompletionsToolChoice = 'none' | 'auto' | 'required' | OpenAIChatCompletionsNamedToolChoice | {
  type: 'allowed_tools'; allowed_tools: { mode: 'auto' | 'required'; tools: OpenAIChatCompletionsNamedToolChoice[] };
};
export type OpenAIChatCompletionsResponseFormat = { type: 'text' } | { type: 'json_object' } | { type: 'json_schema'; json_schema: { name: string; schema?: Record<string, unknown>; description?: string; strict?: boolean | null } };

export interface OpenAIChatCompletionsSystemMessage { role: 'system'; content: string | OpenAIChatCompletionsTextPart[]; name?: string }
export interface OpenAIChatCompletionsDeveloperMessage { role: 'developer'; content: string | OpenAIChatCompletionsTextPart[]; name?: string }
export interface OpenAIChatCompletionsUserMessage { role: 'user'; content: string | OpenAIChatCompletionsUserContentPart[]; name?: string }
export interface OpenAIChatCompletionsToolMessage { role: 'tool'; content: string | OpenAIChatCompletionsTextPart[]; tool_call_id: string }
export interface OpenAIChatCompletionsFunctionMessage { role: 'function'; content: string | null; name: string }
export interface OpenAIChatCompletionsAssistantMessage {
  role: 'assistant';
  content?: string | OpenAIChatCompletionsAssistantContentPart[] | null;
  name?: string;
  refusal?: string | null;
  audio?: { id: string } | null;
  function_call?: { name: string; arguments: string } | null;
  tool_calls?: OpenAIChatCompletionsToolCall[];
}
export type OpenAIChatCompletionsMessage = OpenAIChatCompletionsSystemMessage | OpenAIChatCompletionsDeveloperMessage | OpenAIChatCompletionsUserMessage | OpenAIChatCompletionsAssistantMessage | OpenAIChatCompletionsToolMessage | OpenAIChatCompletionsFunctionMessage;

export interface OpenAIChatCompletionsAssistantOutputMessage extends Omit<OpenAIChatCompletionsAssistantMessage, 'content' | 'audio' | 'name'> {
  role: 'assistant';
  content: string | null;
  refusal: string | null;
  annotations?: OpenAIChatCompletionsAnnotation[];
  audio?: OpenAIChatCompletionsAudio | null;
  function_call?: { name: string; arguments: string } | null;
  tool_calls?: OpenAIChatCompletionsToolCall[];
}
export interface OpenAIChatCompletionsAnnotation { type: 'url_citation'; url_citation: { start_index: number; end_index: number; title: string; url: string } }
export interface OpenAIChatCompletionsAudio { id: string; data: string; expires_at: number; transcript: string }

export interface OpenAIChatCompletionsFunctionToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export interface OpenAIChatCompletionsCustomToolCall { id: string; type: 'custom'; custom: { name: string; input: string } }
export type OpenAIChatCompletionsToolCall = OpenAIChatCompletionsFunctionToolCall | OpenAIChatCompletionsCustomToolCall;

export interface OpenAIChatCompletionsTextPart { type: 'text'; text: string }
export interface OpenAIChatCompletionsImagePart { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' | (string & {}) } }
export interface OpenAIChatCompletionsInputAudioPart { type: 'input_audio'; input_audio: { data: string; format: 'wav' | 'mp3' | (string & {}) } }
export interface OpenAIChatCompletionsFilePart { type: 'file'; file: { file_data?: string; file_id?: string; filename?: string } }
export interface OpenAIChatCompletionsRefusalPart { type: 'refusal'; refusal: string }
export type OpenAIChatCompletionsUserContentPart = OpenAIChatCompletionsTextPart | OpenAIChatCompletionsImagePart | OpenAIChatCompletionsInputAudioPart | OpenAIChatCompletionsFilePart;
export type OpenAIChatCompletionsAssistantContentPart = OpenAIChatCompletionsTextPart | OpenAIChatCompletionsRefusalPart;
export type OpenAIChatCompletionsContentPart = OpenAIChatCompletionsUserContentPart | OpenAIChatCompletionsRefusalPart;

// Provider extension types belong only at the assistant boundary.
export interface OpenAIChatCompletionsAssistantExtensions {
  // Copilot: https://github.com/microsoft/vscode/blob/3d5764c14dea123b0fd50fb61788328c33c076b8/extensions/copilot/src/platform/thinking/common/thinking.ts#L6-L33
  reasoning_text?: string | null;
  reasoning_opaque?: string | null;
  // DeepSeek and compatible providers: https://api-docs.deepseek.com/guides/reasoning_model
  reasoning_content?: string | null;
  // OpenRouter: https://openrouter.ai/docs/guides/best-practices/reasoning-tokens#reasoning-details
  reasoning?: string | null;
  reasoning_details?: unknown;
  // LiteLLM: https://github.com/BerriAI/litellm/blob/cad87a900fbe8b99eba258e6ebb23f58225a8002/litellm/types/llms/openai.py#L646-L651
  reasoning_items?: unknown;
  thinking_blocks?: unknown;
  provider_specific_fields?: unknown;
  [field: string]: unknown;
}
export interface OpenAIChatCompletionsAssistantOutputMessageEx extends OpenAIChatCompletionsAssistantOutputMessage, OpenAIChatCompletionsAssistantExtensions { tool_calls?: OpenAIChatCompletionsToolCallEx[] }
export interface OpenAIChatCompletionsAssistantMessageEx extends OpenAIChatCompletionsAssistantMessage, OpenAIChatCompletionsAssistantExtensions { tool_calls?: OpenAIChatCompletionsToolCallEx[] }
export type OpenAIChatCompletionsToolCallEx = OpenAIChatCompletionsToolCall & {
  // Gemini-compatible upstreams and signature proxies: https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures#openai
  extra_content?: unknown;
  // LiteLLM tool metadata: https://github.com/BerriAI/litellm/blob/cad87a900fbe8b99eba258e6ebb23f58225a8002/litellm/litellm_core_utils/streaming_chunk_builder_utils.py#L572-L600
  provider_specific_fields?: unknown;
};
export interface OpenAIChatCompletionsReasoningItem { type: 'reasoning'; id?: string; summary?: { type: 'summary_text'; text: string }[] }

export type OpenAIChatCompletionsUsage = NonNullable<Official.ChatCompletion['usage']>;

export interface OpenAIChatCompletionsUsageEx extends Omit<OpenAIChatCompletionsUsage, 'prompt_tokens_details'> {
  // Some upstreams report cache creation through this nonstandard alias.
  // https://github.com/caozhiyuan/copilot-api/commit/a99c23551b0f3198d78dd51142dd0096cc6da049
  prompt_tokens_details?: OpenAIChatCompletionsUsage['prompt_tokens_details'] & { cache_creation_input_tokens?: number };
}
export interface OpenAIChatCompletionsLogprobs { content: OpenAIChatCompletionsTokenLogprob[] | null; refusal: OpenAIChatCompletionsTokenLogprob[] | null }
export interface OpenAIChatCompletionsTokenLogprob { token: string; logprob: number; bytes: number[] | null; top_logprobs: { token: string; logprob: number; bytes: number[] | null }[] }
export type OpenAIChatCompletionsFinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'function_call';
export interface OpenAIChatCompletionsChoiceNonStreaming { index: number; message: OpenAIChatCompletionsAssistantOutputMessage; finish_reason: OpenAIChatCompletionsFinishReason; logprobs: OpenAIChatCompletionsLogprobs | null }
export interface OpenAIChatCompletionsResult {
  id: string; object: 'chat.completion'; created: number; model: string;
  metadata?: Official.ChatCompletion['metadata'];
  moderation?: Official.ChatCompletion['moderation'];
  choices: OpenAIChatCompletionsChoiceNonStreaming[];
  service_tier?: 'default' | 'auto' | 'flex' | 'priority' | 'scale' | (string & {}) | null;
  system_fingerprint?: string | null;
  usage?: OpenAIChatCompletionsUsage;
}
export interface OpenAIChatCompletionsToolCallDelta { index: number; id?: string; type?: 'function' | 'custom'; function?: { name?: string; arguments?: string }; custom?: { name?: string; input?: string } }
export interface OpenAIChatCompletionsToolCallDeltaEx extends OpenAIChatCompletionsToolCallDelta { [field: string]: unknown; extra_content?: unknown; provider_specific_fields?: unknown }
interface OpenAIChatCompletionsDeltaFields { audio?: Partial<OpenAIChatCompletionsAudio> | null; content?: string | null; refusal?: string | null; function_call?: { name?: string; arguments?: string }; tool_calls?: OpenAIChatCompletionsToolCallDelta[] }
export interface OpenAIChatCompletionsAssistantDelta extends OpenAIChatCompletionsDeltaFields { role?: 'assistant' }
export type OpenAIChatCompletionsDelta = OpenAIChatCompletionsAssistantDelta | {
  [Role in 'developer' | 'system' | 'user' | 'tool']: OpenAIChatCompletionsDeltaFields & { role: Role };
}['developer' | 'system' | 'user' | 'tool'];
export interface OpenAIChatCompletionsAssistantDeltaEx extends OpenAIChatCompletionsAssistantDelta, OpenAIChatCompletionsAssistantExtensions { annotations?: OpenAIChatCompletionsAnnotation[]; tool_calls?: OpenAIChatCompletionsToolCallDeltaEx[] }
export interface OpenAIChatCompletionsStreamEvent {
  id: string; object: 'chat.completion.chunk'; created: number; model: string;
  moderation?: Official.ChatCompletionChunk['moderation'];
  obfuscation?: Official.ChatCompletionChunk['obfuscation'];
  choices: { index: number; delta: OpenAIChatCompletionsDelta; finish_reason?: OpenAIChatCompletionsFinishReason | null; logprobs?: OpenAIChatCompletionsLogprobs | null }[];
  service_tier?: 'default' | 'auto' | 'flex' | 'priority' | 'scale' | (string & {}) | null;
  system_fingerprint?: string | null;
  usage?: OpenAIChatCompletionsUsage | null;
}

export * from './errors.ts';
export { parseOpenAIChatCompletionsStream, type ParseOpenAIChatCompletionsStreamOptions } from './stream.ts';
export { collectOpenAIChatCompletionsProtocolEventsToResult } from './to-result.ts';
export { createOpenAIChatCompletionsReassembler, reassembleOpenAIChatCompletionsEvents, type OpenAIChatCompletionsReassembler } from './reassemble.ts';
export { openaiChatCompletionsProtocolFrameToSSEFrame } from './to-sse.ts';
