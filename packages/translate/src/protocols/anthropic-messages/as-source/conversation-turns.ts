import type { AnthropicMessagesAssistantMessage, AnthropicMessagesMessage } from '@floway-dev/protocols/anthropic-messages';

export type AnthropicMessagesConversationTurn =
  | { role: 'assistant'; items: AnthropicMessagesAssistantMessage[] }
  | { role: 'user' | 'system'; items: Exclude<AnthropicMessagesMessage, { role: 'assistant' }>[] };

export const partitionAnthropicMessagesTurns = (messages: readonly AnthropicMessagesMessage[]): AnthropicMessagesConversationTurn[] => {
  const turns: AnthropicMessagesConversationTurn[] = [];
  for (const message of messages) {
    const previous = turns.at(-1);
    if (message.role === 'assistant') {
      if (previous?.role === 'assistant') previous.items.push(message);
      else turns.push({ role: 'assistant', items: [message] });
    } else if (previous?.role === message.role) previous.items.push(message);
    else turns.push({ role: message.role, items: [message] });
  }
  return turns;
};
