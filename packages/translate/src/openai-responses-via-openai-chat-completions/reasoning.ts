import { klona } from 'klona/json';

import { encodeChatCompletionsReasoningData, flowayReasoningFields, type OpenAIChatCompletionsReasoningItem } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesInputItem, OpenAIResponsesOutputReasoning } from '@floway-dev/protocols/openai-responses';

export type OpenAIChatCompletionsReasoningSourceItem = Extract<OpenAIResponsesInputItem, { type: 'reasoning' }> | OpenAIResponsesOutputReasoning;

export interface OpenAIChatCompletionsReasoningProjection {
  items: OpenAIChatCompletionsReasoningItem[];
  text?: string;
}

export const createOpenAIChatCompletionsReasoningProjection = (): OpenAIChatCompletionsReasoningProjection => ({
  items: [],
});

export const addOpenAIResponsesReasoningToOpenAIChatCompletionsProjection = (projection: OpenAIChatCompletionsReasoningProjection, item: OpenAIChatCompletionsReasoningSourceItem): void => {
  projection.items.push(klona(item));

  const text = item.summary.map(part => part.text).join('');
  if (projection.text === undefined && text) projection.text = text;
};

export const openaiChatCompletionsReasoningProjectionFields = (projection: OpenAIChatCompletionsReasoningProjection) => {
  const [item] = projection.items;
  const encrypted = item !== undefined && 'encrypted_content' in item ? item.encrypted_content : undefined;
  if (projection.items.length === 1 && typeof encrypted === 'string') return flowayReasoningFields(projection.text ?? '', encrypted);
  const details = projection.items.flatMap((entry, index) => [
    ...(entry.summary ?? []).map(part => ({ type: 'reasoning.summary', summary: part.text, ...(entry.id !== undefined ? { id: entry.id } : {}), index })),
    ...('encrypted_content' in entry && typeof entry.encrypted_content === 'string' ? [{ type: 'reasoning.encrypted', data: entry.encrypted_content, ...(entry.id !== undefined ? { id: entry.id } : {}), index }] : []),
  ]);
  return flowayReasoningFields(projection.text ?? '', details.length > 0 ? encodeChatCompletionsReasoningData('openrouter-reasoning-details', details) : '');
};
