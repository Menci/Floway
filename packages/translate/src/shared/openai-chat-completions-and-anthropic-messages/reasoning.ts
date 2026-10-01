import type { AnthropicMessagesAssistantContentBlock, AnthropicMessagesRedactedThinkingBlock, AnthropicMessagesThinkingBlock } from '@floway-dev/protocols/anthropic-messages';

export interface OpenAIChatCompletionsScalarReasoning {
  reasoningText: string | null;
  reasoningOpaque: string | null;
}

export const anthropicMessagesThinkingBlockFromOpenAIChatCompletionsScalarReasoning = (
  reasoningText: string | null | undefined,
  reasoningOpaque: string | null | undefined,
): AnthropicMessagesThinkingBlock | AnthropicMessagesRedactedThinkingBlock | null => {
  if (reasoningText) {
    return {
      type: 'thinking',
      thinking: reasoningText,
      ...(reasoningOpaque !== undefined && reasoningOpaque !== null ? { signature: reasoningOpaque } : {}),
    };
  }

  return reasoningOpaque !== undefined && reasoningOpaque !== null ? { type: 'redacted_thinking', data: reasoningOpaque } : null;
};

export const openaiChatCompletionsScalarReasoningFromAnthropicMessagesBlock = (block: AnthropicMessagesAssistantContentBlock): OpenAIChatCompletionsScalarReasoning | null => {
  if (block.type === 'thinking') {
    return {
      reasoningText: block.thinking || null,
      reasoningOpaque: block.signature ?? null,
    };
  }

  return block.type === 'redacted_thinking'
    ? {
        reasoningText: null,
        reasoningOpaque: block.data,
      }
    : null;
};
