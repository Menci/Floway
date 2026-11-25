import type * as Official from './sdk.ts';
import type { OpenWire } from '../common/open-wire.ts';

// Request, response and chunk shapes follow the official Chat Completions wire contracts.
// https://github.com/openai/openai-node/blob/7423ac3e9351c46300cd094479cded5551a72eb4/src/resources/chat/completions/completions.ts

export type OpenAIChatCompletionsPayload = Omit<OpenWire<Official.ChatCompletionCreateParamsBase>, 'model' | 'messages' | 'tools' | 'tool_choice' | 'functions' | 'prediction'> & {
  model: string;
  messages: OpenAIChatCompletionsMessage[];
  tools?: OpenAIChatCompletionsTool[];
  tool_choice?: OpenAIChatCompletionsToolChoice;
  functions?: OpenAIChatCompletionsFunctionDefinition[];
  prediction?: { type: 'content'; content: string | OpenAIChatCompletionsTextPart[] } | null;
};

export type OpenAIChatCompletionsStreamOptions = OpenWire<Official.ChatCompletionStreamOptions>;
export interface OpenAIChatCompletionsStreamOptionsEx extends OpenAIChatCompletionsStreamOptions {
  // vLLM/SGLang cumulative streaming usage extension.
  // https://github.com/vllm-project/vllm/blob/d5f0a6e829faa69d1db289bf62b14dae136c02b2/vllm/entrypoints/generate/base/protocol.py#L241-L243
  continuous_usage_stats?: boolean;
}

// OpenAI-compatible clients send an explicit `null` for every absent control,
// including the two the request contract declares non-nullable.
export type OpenAIChatCompletionsPayloadEx = Omit<OpenAIChatCompletionsPayload, 'stream_options' | 'prompt_cache_options' | 'user'> & {
  stream_options?: OpenAIChatCompletionsStreamOptionsEx | null;
  prompt_cache_options?: OpenAIChatCompletionsPayload['prompt_cache_options'] | null;
  user?: string | null;
};

export type OpenAIChatCompletionsFunctionDefinition = OpenWire<Official.ChatCompletionFunctionTool['function']>;
export type OpenAIChatCompletionsFunctionTool = OpenWire<Official.ChatCompletionFunctionTool>;
export type OpenAIChatCompletionsCustomTool = OpenWire<Official.ChatCompletionCustomTool>;
export type OpenAIChatCompletionsTool = OpenAIChatCompletionsFunctionTool | OpenAIChatCompletionsCustomTool;
export type OpenAIChatCompletionsNamedToolChoice = OpenWire<Official.ChatCompletionNamedToolChoice | Official.ChatCompletionNamedToolChoiceCustom>;
export type OpenAIChatCompletionsToolChoice = OpenWire<Official.ChatCompletionToolChoiceOption>;
export type OpenAIChatCompletionsResponseFormat = OpenWire<NonNullable<Official.ChatCompletionCreateParamsBase['response_format']>>;

export type OpenAIChatCompletionsSystemMessage = OpenWire<Official.ChatCompletionSystemMessageParam>;
export type OpenAIChatCompletionsDeveloperMessage = OpenWire<Official.ChatCompletionDeveloperMessageParam>;
export type OpenAIChatCompletionsUserMessage = OpenWire<Official.ChatCompletionUserMessageParam>;
export type OpenAIChatCompletionsToolMessage = OpenWire<Official.ChatCompletionToolMessageParam>;
export type OpenAIChatCompletionsFunctionMessage = OpenWire<Official.ChatCompletionFunctionMessageParam>;
export type OpenAIChatCompletionsAssistantMessage = OpenWire<Official.ChatCompletionAssistantMessageParam>;
export type OpenAIChatCompletionsMessage = OpenAIChatCompletionsSystemMessage | OpenAIChatCompletionsDeveloperMessage | OpenAIChatCompletionsUserMessage | OpenAIChatCompletionsAssistantMessage | OpenAIChatCompletionsToolMessage | OpenAIChatCompletionsFunctionMessage;

export type OpenAIChatCompletionsAssistantOutputMessage = OpenWire<Official.ChatCompletionMessage>;
export type OpenAIChatCompletionsAnnotation = OpenWire<Official.ChatCompletionMessage.Annotation>;
export type OpenAIChatCompletionsAudio = OpenWire<Official.ChatCompletionAudio>;

export type OpenAIChatCompletionsFunctionToolCall = OpenWire<Official.ChatCompletionMessageFunctionToolCall>;
export type OpenAIChatCompletionsCustomToolCall = OpenWire<Official.ChatCompletionMessageCustomToolCall>;
export type OpenAIChatCompletionsToolCall = OpenAIChatCompletionsFunctionToolCall | OpenAIChatCompletionsCustomToolCall;

export type OpenAIChatCompletionsTextPart = OpenWire<Official.ChatCompletionContentPartText>;
export type OpenAIChatCompletionsImagePart = OpenWire<Official.ChatCompletionContentPartImage>;
export type OpenAIChatCompletionsInputAudioPart = OpenWire<Official.ChatCompletionContentPartInputAudio>;
export type OpenAIChatCompletionsFilePart = OpenWire<Official.ChatCompletionContentPart.File>;
export type OpenAIChatCompletionsRefusalPart = OpenWire<Official.ChatCompletionContentPartRefusal>;
export type OpenAIChatCompletionsUserContentPart = OpenAIChatCompletionsTextPart | OpenAIChatCompletionsImagePart | OpenAIChatCompletionsInputAudioPart | OpenAIChatCompletionsFilePart;
export type OpenAIChatCompletionsAssistantContentPart = OpenAIChatCompletionsTextPart | OpenAIChatCompletionsRefusalPart;

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
// LiteLLM `reasoning_items` entries.
// https://github.com/BerriAI/litellm/blob/cad87a900fbe8b99eba258e6ebb23f58225a8002/litellm/types/llms/openai.py#L646-L651
export interface OpenAIChatCompletionsReasoningItemEx { type: 'reasoning'; id?: string; summary?: { type: 'summary_text'; text: string }[] }

export type OpenAIChatCompletionsUsage = NonNullable<Official.ChatCompletion['usage']>;

export interface OpenAIChatCompletionsUsageEx extends Omit<OpenAIChatCompletionsUsage, 'prompt_tokens_details'> {
  // Some upstreams report cache creation through this nonstandard alias.
  // https://github.com/caozhiyuan/copilot-api/commit/a99c23551b0f3198d78dd51142dd0096cc6da049
  prompt_tokens_details?: OpenAIChatCompletionsUsage['prompt_tokens_details'] & { cache_creation_input_tokens?: number };
}
export type OpenAIChatCompletionsLogprobs = OpenWire<Official.ChatCompletion.Choice.Logprobs>;
export type OpenAIChatCompletionsTokenLogprob = OpenWire<Official.ChatCompletionTokenLogprob>;
export type OpenAIChatCompletionsFinishReason = OpenWire<Official.ChatCompletion.Choice['finish_reason']>;
export type OpenAIChatCompletionsChoiceNonStreaming = OpenWire<Official.ChatCompletion.Choice>;
export interface OpenAIChatCompletionsChoiceNonStreamingEx extends Omit<OpenAIChatCompletionsChoiceNonStreaming, 'message'> {
  [field: string]: unknown;
  message: OpenAIChatCompletionsAssistantOutputMessageEx;
}
// Compatible upstreams send an explicit `null` system fingerprint.
// https://github.com/openai/openai-openapi/blob/db14b6e1712aaf5265cf5a6871adff7a9c61d31c/openapi.yaml
export type OpenAIChatCompletionsResult = Omit<OpenWire<Official.ChatCompletion>, 'system_fingerprint'> & {
  system_fingerprint?: string | null;
};
export interface OpenAIChatCompletionsResultEx extends Omit<OpenAIChatCompletionsResult, 'choices'> {
  [field: string]: unknown;
  choices: OpenAIChatCompletionsChoiceNonStreamingEx[];
}
export type OpenAIChatCompletionsToolCallDelta = OpenWire<Official.ChatCompletionChunk.Choice.Delta.ToolCall>;
export interface OpenAIChatCompletionsToolCallDeltaEx extends OpenAIChatCompletionsToolCallDelta { [field: string]: unknown; extra_content?: unknown; provider_specific_fields?: unknown }
type OpenAIChatCompletionsDeltaFields = Omit<OpenWire<Official.ChatCompletionChunk.Choice.Delta>, 'role'> & { audio?: Partial<OpenAIChatCompletionsAudio> | null };
export interface OpenAIChatCompletionsAssistantDelta extends OpenAIChatCompletionsDeltaFields { role?: 'assistant' }
export type OpenAIChatCompletionsDelta = OpenAIChatCompletionsAssistantDelta | {
  [Role in 'developer' | 'system' | 'user' | 'tool']: OpenAIChatCompletionsDeltaFields & { role: Role };
}['developer' | 'system' | 'user' | 'tool'];
export interface OpenAIChatCompletionsAssistantDeltaEx extends OpenAIChatCompletionsAssistantDelta, OpenAIChatCompletionsAssistantExtensions { annotations?: OpenAIChatCompletionsAnnotation[]; tool_calls?: OpenAIChatCompletionsToolCallDeltaEx[] }
export type OpenAIChatCompletionsStreamEvent = Omit<OpenWire<Official.ChatCompletionChunk>, 'choices' | 'system_fingerprint'> & {
  choices: (Omit<OpenWire<Official.ChatCompletionChunk.Choice>, 'delta' | 'finish_reason'> & {
    delta: OpenAIChatCompletionsDelta;
    finish_reason?: OpenWire<Official.ChatCompletionChunk.Choice['finish_reason']>;
  })[];
  system_fingerprint?: string | null;
};

export * from './errors.ts';
export { parseOpenAIChatCompletionsStream, type ParseOpenAIChatCompletionsStreamOptions } from './stream.ts';
export { formatOpenAIError as formatOpenAIChatCompletionsError } from '../common/openai-error.ts';
export { collectOpenAIChatCompletionsProtocolEventsToResult } from './to-result.ts';
export { createOpenAIChatCompletionsEventAccumulator, reassembleOpenAIChatCompletionsEvents, type OpenAIChatCompletionsEventAccumulator } from './reassemble.ts';
export { openaiChatCompletionsProtocolFrameToSSEFrame } from './to-sse.ts';

export { toOpenAIChatCompletionsInputAssistantMessage } from './history.ts';
