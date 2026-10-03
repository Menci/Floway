import { CHAT_COMPLETIONS_REASONING_TEXT_STANDARDS, CHAT_COMPLETIONS_REASONING_DATA_STANDARDS, type ChatCompletionsReasoningFormat, type ChatCompletionsReasoningOverrides } from '@floway-dev/protocols/openai-chat-completions';

// Operator settings and provider-owned model opinions share this sparse shape.
// Endpoint availability is independent, so disabling an endpoint retains its settings.
export interface Compatibility {
  openaiChatCompletions?: {
    reasoning?: ChatCompletionsReasoningOverrides;
  };
}

export interface CompatibilityDefaults {
  openaiChatCompletions: {
    reasoning: ChatCompletionsReasoningFormat;
  };
}

const objectField = (value: unknown, keys: readonly string[], label: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`Malformed ${label}: must be an object`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`Malformed ${label}: unknown field ${key}`);
  return value as Record<string, unknown>;
};

const reasoningOverridesField = (value: unknown, label: string): ChatCompletionsReasoningOverrides => {
  const source = objectField(value, ['text', 'data'], label);
  const reasoning: ChatCompletionsReasoningOverrides = {};
  if (source.text !== undefined) {
    if (!(CHAT_COMPLETIONS_REASONING_TEXT_STANDARDS as readonly unknown[]).includes(source.text)) throw new Error(`Malformed ${label}.text`);
    reasoning.text = source.text as NonNullable<ChatCompletionsReasoningOverrides['text']>;
  }
  if (source.data !== undefined) {
    if (!(CHAT_COMPLETIONS_REASONING_DATA_STANDARDS as readonly unknown[]).includes(source.data)) throw new Error(`Malformed ${label}.data`);
    reasoning.data = source.data as NonNullable<ChatCompletionsReasoningOverrides['data']>;
  }
  return reasoning;
};

export const compatibilityField = (value: unknown, label: string): Compatibility => {
  const raw = objectField(value, ['openaiChatCompletions'], label);
  if (raw.openaiChatCompletions === undefined) return {};
  const chat = objectField(raw.openaiChatCompletions, ['reasoning'], `${label}.openaiChatCompletions`);
  if (chat.reasoning === undefined) return { openaiChatCompletions: {} };
  return { openaiChatCompletions: { reasoning: reasoningOverridesField(chat.reasoning, `${label}.openaiChatCompletions.reasoning`) } };
};
