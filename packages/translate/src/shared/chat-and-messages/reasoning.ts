import type { MessagesAssistantContentBlock, MessagesRedactedThinkingBlock, MessagesThinkingBlock } from '@floway-dev/protocols/messages';

export interface ChatScalarReasoning {
  reasoningText: string | null;
  reasoningOpaque: string | null;
  hasReasoningOpaque: boolean;
}

export const messagesThinkingBlockFromChatScalarReasoning = (
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

export const chatScalarReasoningFromMessagesBlock = (block: MessagesAssistantContentBlock): ChatScalarReasoning | null => {
  if (block.type === 'thinking') {
    return {
      reasoningText: block.thinking || null,
      reasoningOpaque: Object.hasOwn(block, 'signature') ? block.signature ?? null : null,
      hasReasoningOpaque: Object.hasOwn(block, 'signature'),
    };
  }

  return block.type === 'redacted_thinking'
    ? {
        reasoningText: null,
        reasoningOpaque: block.data,
        hasReasoningOpaque: true,
      }
    : null;
};
