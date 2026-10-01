import { klona } from 'klona/json';

import { decodeChatCompletionsReasoningData, openAIChatCompletionsReasoningOpaque, type OpenAIChatCompletionsReasoningItem, type FlowayOpenAIChatCompletionsReasoningCarrier } from '@floway-dev/protocols/openai-chat-completions';
import { createRandomOpenAIResponsesItemId, type OpenAIResponsesReasoningItem } from '@floway-dev/protocols/openai-responses';

export const openAIChatCompletionsReasoningItems = (message: FlowayOpenAIChatCompletionsReasoningCarrier): OpenAIChatCompletionsReasoningItem[] | undefined => {
  const opaque = openAIChatCompletionsReasoningOpaque(message);
  if (opaque === undefined) return undefined;
  const envelope = decodeChatCompletionsReasoningData(opaque);
  if (envelope?.type !== 'openai-responses-reasoning-items') return undefined;
  if (!Array.isArray(envelope.value) || envelope.value.some(item =>
    typeof item !== 'object' || item === null || Array.isArray(item) || item.type !== 'reasoning' || typeof item.id !== 'string' || !Array.isArray(item.summary)
    || item.summary.some((part: unknown) => typeof part !== 'object' || part === null || Array.isArray(part) || !('text' in part) || typeof part.text !== 'string'))) throw new TypeError('Malformed Floway Responses reasoning items');
  return envelope.value as OpenAIChatCompletionsReasoningItem[];
};

export const toOpenAIResponsesReasoningItem = <T extends OpenAIResponsesReasoningItem>(item: OpenAIChatCompletionsReasoningItem): T =>
  ({
    ...item,
    type: 'reasoning',
    id: item.id ?? createRandomOpenAIResponsesItemId('reasoning'),
    summary: item.summary ?? [],
  } as T);

export const scalarToOpenAIResponsesReasoningItem = <T extends OpenAIResponsesReasoningItem>(reasoningText: string | null | undefined): T | null => {
  if (!reasoningText) return null;

  return {
    type: 'reasoning',
    id: createRandomOpenAIResponsesItemId('reasoning'),
    summary: reasoningText ? [{ type: 'summary_text', text: reasoningText }] : [],
  } as T;
};

export const translateOpenAIChatCompletionsReasoningItems = <T extends OpenAIResponsesReasoningItem>(reasoningItems: OpenAIChatCompletionsReasoningItem[] | null | undefined): T[] | null =>
  reasoningItems == null ? null : reasoningItems.map(item => ({ ...toOpenAIResponsesReasoningItem<T>(item), summary: klona(item.summary ?? []) } as T));
