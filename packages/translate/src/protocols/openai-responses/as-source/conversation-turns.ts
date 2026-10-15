import { assistantItemTypeNames } from '../common/assistant-items.ts';
import type { CanonicalOpenAIResponsesInputItem } from '@floway-dev/protocols/openai-responses';

export type OpenAIResponsesConversationTurn = { role: 'assistant' | 'bare'; items: CanonicalOpenAIResponsesInputItem[] };

const assistantItemTypes = new Set<string>(assistantItemTypeNames);
const isResponsesAssistantItem = (item: CanonicalOpenAIResponsesInputItem): boolean => item.type === 'message'
  ? item.role === 'assistant'
  : assistantItemTypes.has(item.type);

export const partitionOpenAIResponsesTurns = (input: readonly CanonicalOpenAIResponsesInputItem[]): OpenAIResponsesConversationTurn[] => {
  const turns: OpenAIResponsesConversationTurn[] = [];
  for (const item of input) {
    if (item.type === 'additional_tools' || item.type === 'tool_search_output') continue;
    const role = isResponsesAssistantItem(item) ? 'assistant' : 'bare';
    const previous = turns.at(-1);
    if (previous?.role === role) previous.items.push(item);
    else turns.push({ role, items: [item] });
  }
  return turns;
};
