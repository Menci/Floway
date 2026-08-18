import type { OpenAIChatCompletionsReasoningItem } from '@floway-dev/protocols/openai-chat-completions';
import { createRandomOpenAIResponsesItemId, type OpenAIResponsesInputItem, type OpenAIResponsesOutputReasoning, type OpenAIResponsesReasoningItem } from '@floway-dev/protocols/openai-responses';

export type OpenAIChatCompletionsReasoningSourceItem = Extract<OpenAIResponsesInputItem, { type: 'reasoning' }> | OpenAIResponsesOutputReasoning;

export interface OpenAIChatCompletionsReasoningProjection {
  items: OpenAIChatCompletionsReasoningItem[];
  text?: string;
}

export const createOpenAIChatCompletionsReasoningProjection = (): OpenAIChatCompletionsReasoningProjection => ({
  items: [],
});

export const toOpenAIChatCompletionsReasoningItem = (item: OpenAIChatCompletionsReasoningSourceItem): OpenAIChatCompletionsReasoningItem => ({
  type: 'reasoning',
  id: item.id,
  summary: item.summary,
});

export const addOpenAIResponsesReasoningToOpenAIChatCompletionsProjection = (projection: OpenAIChatCompletionsReasoningProjection, item: OpenAIChatCompletionsReasoningSourceItem): void => {
  projection.items.push(toOpenAIChatCompletionsReasoningItem(item));

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

  // `reasoning_items[]` is a LiteLLM-inspired compatibility workaround for
  // carrying multiple readable OpenAI Responses reasoning summaries through OpenAI Chat Completions.
  // Scalars remain first-group only.
  // References:
  // - https://github.com/BerriAI/litellm/blob/70492cee4282541256fb9ac963be94412b1a109c/litellm/completion_extras/litellm_responses_transformation/transformation.py#L59-L104
  // - https://github.com/BerriAI/litellm/blob/70492cee4282541256fb9ac963be94412b1a109c/litellm/completion_extras/litellm_responses_transformation/transformation.py#L1322-L1355
  const translated = reasoningItems.flatMap(item => (hasReadableSummary(item) ? [toOpenAIResponsesReasoningItem<T>(item)] : []));
  return translated.length > 0 ? translated : null;
};
