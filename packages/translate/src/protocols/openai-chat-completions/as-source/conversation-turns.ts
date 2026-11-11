import type { OpenAIChatCompletionsAssistantMessage, OpenAIChatCompletionsAssistantMessageEx, OpenAIChatCompletionsMessage } from '@floway-dev/protocols/openai-chat-completions';

export type OpenAIChatCompletionsConversationMessage = OpenAIChatCompletionsMessage | OpenAIChatCompletionsAssistantMessageEx;
export type OpenAIChatCompletionsConversationTurn =
  | { role: 'assistant'; items: [OpenAIChatCompletionsAssistantMessage | OpenAIChatCompletionsAssistantMessageEx] }
  | { role: 'client'; items: Exclude<OpenAIChatCompletionsMessage, { role: 'assistant' }>[] };
// Each assistant message forms its own turn; adjacent nonprompt client messages form one client run.
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
      turns.push({ role: 'client', items: [message] });
      continue;
    }
    if (previous?.role === 'client' && previous.items.every(item => item.role !== 'system' && item.role !== 'developer')) previous.items.push(message);
    else turns.push({ role: 'client', items: [message] });
  }
  return turns;
};
