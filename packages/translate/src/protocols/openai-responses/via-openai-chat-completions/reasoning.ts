import { klona } from 'klona/json';

import type { OpenAIChatCompletionsReasoningItem } from '@floway-dev/protocols/openai-chat-completions';
import { createRandomOpenAIResponsesItemId, type CanonicalOpenAIResponsesInputItem, type OpenAIResponsesOutputReasoning, type OpenAIResponsesReasoningItem } from '@floway-dev/protocols/openai-responses';

export type OpenAIChatCompletionsReasoningSourceItem = Extract<CanonicalOpenAIResponsesInputItem, { type: 'reasoning' }> | OpenAIResponsesOutputReasoning;

export interface OpenAIChatCompletionsReasoningProjection {
  items: OpenAIChatCompletionsReasoningItem[];
  text?: string;
}

export const createOpenAIChatCompletionsReasoningProjection = (): OpenAIChatCompletionsReasoningProjection => ({
  items: [],
});

export const toOpenAIChatCompletionsReasoningItem = (item: OpenAIChatCompletionsReasoningSourceItem): OpenAIChatCompletionsReasoningItem => ({
  type: 'reasoning',
  ...(item.id == null ? {} : { id: item.id }),
  summary: item.summary,
});

export const addOpenAIResponsesReasoningToOpenAIChatCompletionsProjection = (projection: OpenAIChatCompletionsReasoningProjection, item: OpenAIChatCompletionsReasoningSourceItem): void => {
  projection.items.push({ ...toOpenAIChatCompletionsReasoningItem(item), summary: klona(item.summary) });

  const text = item.summary.map(part => part.text).join('');
  if (projection.text === undefined && text) projection.text = text;
};

export const openaiChatCompletionsReasoningProjectionFields = (projection: OpenAIChatCompletionsReasoningProjection) => ({
  ...(projection.text !== undefined ? { reasoning_text: projection.text } : {}),
  ...(projection.items.length > 0 ? { reasoning_items: projection.items } : {}),
});

export const toOpenAIResponsesReasoningItem = <T extends OpenAIResponsesReasoningItem>(item: OpenAIChatCompletionsReasoningItem): T =>
  ({
    type: 'reasoning',
    id: item.id ?? createRandomOpenAIResponsesItemId('reasoning'),
    summary: item.summary ?? [],
  } as T);
