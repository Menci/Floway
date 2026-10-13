import type { AnthropicMessagesAssistantContentBlock } from '@floway-dev/protocols/anthropic-messages';

export const openAIChatCompletionsReasoningTextFromAnthropicMessagesBlock = (block: AnthropicMessagesAssistantContentBlock): string | null =>
  block.type === 'thinking' && block.thinking.length > 0 ? block.thinking : null;
