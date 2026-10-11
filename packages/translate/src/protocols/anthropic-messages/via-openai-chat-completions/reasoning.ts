import type { AnthropicMessagesAssistantContentBlock } from '@floway-dev/protocols/anthropic-messages';

export interface OpenAIChatCompletionsScalarReasoning {
  reasoningText: string | null;
  reasoningOpaque: string | null;
}

export const openaiChatCompletionsScalarReasoningFromAnthropicMessagesBlock = (block: AnthropicMessagesAssistantContentBlock): OpenAIChatCompletionsScalarReasoning | null => {
  if (block.type === 'thinking') {
    return {
      reasoningText: block.thinking || null,
      reasoningOpaque: block.signature || null,
    };
  }

  return block.type === 'redacted_thinking'
    ? {
        reasoningText: null,
        reasoningOpaque: block.data,
      }
    : null;
};
