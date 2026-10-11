import type { AnthropicMessagesRedactedThinkingBlock, AnthropicMessagesThinkingBlock } from '@floway-dev/protocols/anthropic-messages';

export const anthropicMessagesThinkingBlockFromOpenAIChatCompletionsScalarReasoning = (
  reasoningText: string | null | undefined,
  reasoningOpaque: string | null | undefined,
): AnthropicMessagesThinkingBlock | AnthropicMessagesRedactedThinkingBlock | null => {
  if (reasoningText) {
    return {
      type: 'thinking',
      thinking: reasoningText,
      signature: reasoningOpaque ?? '',
    };
  }

  return reasoningOpaque !== undefined && reasoningOpaque !== null ? { type: 'redacted_thinking', data: reasoningOpaque } : null;
};
