import type { AnthropicMessagesRedactedThinkingBlock, AnthropicMessagesThinkingBlock } from '@floway-dev/protocols/anthropic-messages';
import type { OpenAIResponsesInputReasoning } from '@floway-dev/protocols/openai-responses';

type AnthropicMessagesReasoningBlock = AnthropicMessagesThinkingBlock | AnthropicMessagesRedactedThinkingBlock;

export const anthropicMessagesReasoningBlockToOpenAIResponsesReasoning = (block: AnthropicMessagesReasoningBlock): OpenAIResponsesInputReasoning | null => {
  if (block.type !== 'thinking' || block.thinking.length === 0) return null;
  return {
    type: 'reasoning',
    summary: [{ type: 'summary_text', text: block.thinking }],
  };
};
