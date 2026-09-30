export const CHAT_COMPLETIONS_REASONING_TEXT_STANDARDS = ['reasoning-content', 'reasoning-text', 'reasoning'] as const;
export const CHAT_COMPLETIONS_REASONING_DATA_STANDARDS = ['none', 'reasoning-opaque', 'openrouter-reasoning-details', 'litellm-thinking-blocks'] as const;

export type ChatCompletionsReasoningTextStandard = typeof CHAT_COMPLETIONS_REASONING_TEXT_STANDARDS[number];
export type ChatCompletionsReasoningDataStandard = typeof CHAT_COMPLETIONS_REASONING_DATA_STANDARDS[number];

export interface ChatCompletionsReasoningFormat {
  text: ChatCompletionsReasoningTextStandard;
  data: ChatCompletionsReasoningDataStandard;
}

export type ChatCompletionsReasoningOverrides = Partial<ChatCompletionsReasoningFormat>;
export const FlowayOpenAIChatCompletionsReasoning: unique symbol = Symbol('Floway OpenAI Chat Completions reasoning');

export interface FlowayOpenAIChatCompletionsReasoningValue {
  readonly reasoning: string;
  readonly reasoning_opaque: string;
}

export interface FlowayOpenAIChatCompletionsReasoningCarrier {
  readonly [FlowayOpenAIChatCompletionsReasoning]?: FlowayOpenAIChatCompletionsReasoningValue;
}

export const flowayReasoningFields = (reasoning: string, reasoningOpaque: string): FlowayOpenAIChatCompletionsReasoningCarrier =>
  reasoning === '' && reasoningOpaque === '' ? {} : { [FlowayOpenAIChatCompletionsReasoning]: Object.freeze({ reasoning, reasoning_opaque: reasoningOpaque }) };
