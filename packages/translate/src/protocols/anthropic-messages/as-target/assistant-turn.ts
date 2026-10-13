import type { AnthropicMessagesAssistantContentBlock } from '@floway-dev/protocols/anthropic-messages';

export type AnthropicMessagesInputAssistantTurn = {
  role: 'assistant';
  content: AnthropicMessagesAssistantContentBlock[];
};
