import type { MessagesRedactedThinkingBlock, MessagesThinkingBlock } from '@floway-dev/protocols/messages';
import type { ResponseInputReasoning, ResponsesReasoningItem } from '@floway-dev/protocols/responses';

export type MessagesReasoningBlock = MessagesThinkingBlock | MessagesRedactedThinkingBlock;

export const messagesReasoningBlockToResponsesReasoning = (block: MessagesReasoningBlock, index: number): ResponseInputReasoning | null => {
  if (block.type === 'redacted_thinking') return null;

  return {
    type: 'reasoning',
    id: `rs_${index}`,
    summary: block.thinking ? [{ type: 'summary_text', text: block.thinking }] : [],
  };
};

export const responsesReasoningToMessagesBlock = (item: ResponsesReasoningItem): MessagesThinkingBlock | null => {
  const thinking = item.summary?.length
    ? item.summary
        .map(part => part.text)
        .join('')
        .trim()
    : '';

  return thinking ? { type: 'thinking', thinking } : null;
};
