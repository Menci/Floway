import type { AnthropicMessagesThinkingBlock } from '@floway-dev/protocols/anthropic-messages';
import type { OpenAIResponsesReasoningItem } from '@floway-dev/protocols/openai-responses';

export const openaiResponsesReasoningToAnthropicMessagesUpstreamBlock = (item: OpenAIResponsesReasoningItem): AnthropicMessagesThinkingBlock | null => {
  const thinking = item.summary?.map(part => part.text).join('') ?? '';
  return thinking.length > 0 ? { type: 'thinking', thinking, signature: '' } : null;
};
