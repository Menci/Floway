import { klona } from 'klona/json';

import { encodeReasoningData, decodeReasoningData } from '@floway-dev/protocols/common';
import { type OpenAIChatCompletionsReasoningItem, flowayReasoningFields, FlowayOpenAIChatCompletionsReasoning, type FlowayOpenAIChatCompletionsReasoningCarrier  } from '@floway-dev/protocols/openai-chat-completions';
import { createRandomOpenAIResponsesItemId, type OpenAIResponsesInputItem, type OpenAIResponsesOutputReasoning, type OpenAIResponsesReasoningItem } from '@floway-dev/protocols/openai-responses';

export const openAIChatCompletionsScalarReasoningText = (message: FlowayOpenAIChatCompletionsReasoningCarrier): string | undefined => {
  const value = message[FlowayOpenAIChatCompletionsReasoning]?.reasoning;
  return value === '' ? undefined : value;
};

export const openAIChatCompletionsReasoningOpaque = (message: FlowayOpenAIChatCompletionsReasoningCarrier): string | undefined => {
  const value = message[FlowayOpenAIChatCompletionsReasoning]?.reasoning_opaque;
  return value === '' ? undefined : value;
};

export const openAIChatCompletionsReasoningItems = (message: FlowayOpenAIChatCompletionsReasoningCarrier): OpenAIChatCompletionsReasoningItem[] | undefined => {
  const opaque = openAIChatCompletionsReasoningOpaque(message);
  if (opaque === undefined) return undefined;
  const envelope = decodeReasoningData(opaque);
  if (envelope?.type !== 'openai-responses-reasoning-items') return undefined;
  if (!Array.isArray(envelope.value)) throw new TypeError('Malformed Floway Responses reasoning items');
  return envelope.value as OpenAIChatCompletionsReasoningItem[];
};

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
  const bridge = typeof encrypted === 'string' ? decodeReasoningData(encrypted) : undefined;
  if (projection.items.length === 1 && bridge?.type === 'chat-completions-reasoning') {
    if (typeof bridge.value !== 'string') throw new TypeError('Malformed Floway Chat Completions reasoning bridge');
    return flowayReasoningFields(projection.text ?? '', bridge.value);
  }
  return flowayReasoningFields(projection.text ?? '', projection.items.length > 0 ? encodeReasoningData('openai-responses-reasoning-items', projection.items) : '');
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

export const hasReadableSummary = (item: OpenAIChatCompletionsReasoningItem): boolean => item.summary?.some(part => part.text) === true;

export const translateOpenAIChatCompletionsReasoningItems = <T extends OpenAIResponsesReasoningItem>(reasoningItems: OpenAIChatCompletionsReasoningItem[] | null | undefined): T[] | null => {
  if (!reasoningItems?.length) return null;

  const translated = reasoningItems.flatMap(item => (hasReadableSummary(item) || ('encrypted_content' in item && typeof item.encrypted_content === 'string')
    ? [{ ...toOpenAIResponsesReasoningItem<T>(item), summary: klona(item.summary ?? []) } as T]
    : []));
  return translated.length > 0 ? translated : null;
};
