import type { MessagesAssistantContentBlock, MessagesRedactedThinkingBlock, MessagesThinkingBlock } from '@floway-dev/protocols/messages';

export interface ChatCompletionsScalarReasoning {
  reasoningText: string | null;
  reasoningOpaque: string | null;
}

export const messagesThinkingBlockFromChatCompletionsScalarReasoning = (
  reasoningText: string | null | undefined,
  reasoningOpaque: string | null | undefined,
): MessagesThinkingBlock | MessagesRedactedThinkingBlock | null => {
  if (reasoningText) {
    return {
      type: 'thinking',
      thinking: reasoningText,
      ...(reasoningOpaque !== undefined && reasoningOpaque !== null ? { signature: reasoningOpaque } : {}),
    };
  }

  return reasoningOpaque !== undefined && reasoningOpaque !== null ? { type: 'redacted_thinking', data: reasoningOpaque } : null;
};

export const chatCompletionsScalarReasoningFromMessagesBlock = (block: MessagesAssistantContentBlock): ChatCompletionsScalarReasoning | null => {
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
