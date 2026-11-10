import { isOpenAIResponsesAssistantInputItem, type CanonicalOpenAIResponsesInputItem } from '@floway-dev/protocols/openai-responses';

export type OpenAIResponsesConversationTurn = { role: 'assistant' | 'client'; items: CanonicalOpenAIResponsesInputItem[] };

// A system or developer message is a prompt boundary of its own: a target that
// hoists it into a top-level slot, or keeps it inline, needs it to stay separate
// from the client content around it.
const isPromptBoundary = (item: CanonicalOpenAIResponsesInputItem): boolean =>
  item.type === 'message' && (item.role === 'system' || item.role === 'developer');

export const partitionOpenAIResponsesTurns = (input: readonly CanonicalOpenAIResponsesInputItem[]): OpenAIResponsesConversationTurn[] => {
  const turns: OpenAIResponsesConversationTurn[] = [];
  for (const item of input) {
    const role = isOpenAIResponsesAssistantInputItem(item) ? 'assistant' : 'client';
    const previous = turns.at(-1);
    if (isPromptBoundary(item) || previous?.role !== role || previous.items.some(isPromptBoundary)) {
      turns.push({ role, items: [item] });
      continue;
    }
    previous.items.push(item);
  }
  return turns;
};
