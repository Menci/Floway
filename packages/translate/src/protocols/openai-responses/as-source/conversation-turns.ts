import { isOpenAIResponsesAssistantInputItem, type CanonicalOpenAIResponsesInputItem } from '@floway-dev/protocols/openai-responses';

export type OpenAIResponsesConversationTurn = {
  readonly role: 'assistant' | 'client';
  readonly items: CanonicalOpenAIResponsesInputItem[];
};

// A system or developer message keeps its own boundary and role instead of
// joining the client content around it.
const isRoleMessageBoundary = (item: CanonicalOpenAIResponsesInputItem): boolean =>
  item.type === 'message' && (item.role === 'system' || item.role === 'developer');

export const partitionOpenAIResponsesTurns = (input: readonly CanonicalOpenAIResponsesInputItem[]): OpenAIResponsesConversationTurn[] => {
  const turns: { role: 'assistant' | 'client'; items: CanonicalOpenAIResponsesInputItem[] }[] = [];
  for (const item of input) {
    const role = isOpenAIResponsesAssistantInputItem(item) ? 'assistant' : 'client';
    const previous = turns.at(-1);
    if (isRoleMessageBoundary(item) || previous?.role !== role || previous.items.some(isRoleMessageBoundary)) {
      turns.push({ role, items: [item] });
      continue;
    }
    previous.items.push(item);
  }
  return turns;
};
