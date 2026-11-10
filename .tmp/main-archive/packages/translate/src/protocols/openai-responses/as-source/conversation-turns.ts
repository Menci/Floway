import { isOpenAIResponsesAssistantInputItem, type CanonicalOpenAIResponsesInputItem } from '@floway-dev/protocols/openai-responses';

export type OpenAIResponsesConversationTurn = { role: 'assistant' | 'bare'; items: CanonicalOpenAIResponsesInputItem[] };

export const partitionOpenAIResponsesTurns = (input: readonly CanonicalOpenAIResponsesInputItem[]): OpenAIResponsesConversationTurn[] => {
  const turns: OpenAIResponsesConversationTurn[] = [];
  for (const item of input) {
    const role = isOpenAIResponsesAssistantInputItem(item) ? 'assistant' : 'bare';
    const previous = turns.at(-1);
    if (previous?.role === role) previous.items.push(item);
    else turns.push({ role, items: [item] });
  }
  return turns;
};
