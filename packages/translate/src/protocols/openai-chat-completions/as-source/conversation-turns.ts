import type { OpenAIChatCompletionsAssistantMessage, OpenAIChatCompletionsAssistantMessageEx, OpenAIChatCompletionsMessage } from '@floway-dev/protocols/openai-chat-completions';

export type OpenAIChatCompletionsConversationMessage = OpenAIChatCompletionsMessage | OpenAIChatCompletionsAssistantMessageEx;
export type OpenAIChatCompletionsConversationTurn =
  | { role: 'assistant'; items: [OpenAIChatCompletionsAssistantMessage | OpenAIChatCompletionsAssistantMessageEx] }
  | { role: 'bare'; items: Exclude<OpenAIChatCompletionsMessage, { role: 'assistant' }>[] };
// The assistant branch is a single message; a client run holds one or more.

// A run of client messages is one turn, the same way every other protocol
// partitions: a Chat wire lets a client state several messages that one target
// message expresses, and the turn boundary is what keeps two such runs apart.
export const partitionOpenAIChatCompletionsTurns = (messages: readonly OpenAIChatCompletionsConversationMessage[]): OpenAIChatCompletionsConversationTurn[] => {
  const turns: OpenAIChatCompletionsConversationTurn[] = [];
  for (const message of messages) {
    const previous = turns.at(-1);
    // A system or developer message is a prompt boundary of its own: a target
    // that hoists it into a top-level slot, or keeps it inline, needs it to stay
    // separate from the client content around it.
    if (message.role === 'assistant') {
      turns.push({ role: 'assistant', items: [message] });
      continue;
    }
    if (message.role === 'system' || message.role === 'developer') {
      turns.push({ role: 'bare', items: [message] });
      continue;
    }
    if (previous?.role === 'bare' && previous.items.every(item => item.role !== 'system' && item.role !== 'developer')) previous.items.push(message);
    else turns.push({ role: 'bare', items: [message] });
  }
  return turns;
};
