import { klona } from 'klona/json';

import { hasReadableSummary } from '../common/reasoning.ts';
import type { OpenAIChatCompletionsReasoningItem } from '@floway-dev/protocols/openai-chat-completions';
import { createRandomOpenAIResponsesItemId, type CanonicalOpenAIResponsesInputItem, type OpenAIResponsesOutputReasoning, type OpenAIResponsesReasoningItem } from '@floway-dev/protocols/openai-responses';

export type OpenAIChatCompletionsReasoningSourceItem = Extract<CanonicalOpenAIResponsesInputItem, { type: 'reasoning' }> | OpenAIResponsesOutputReasoning;

export const toOpenAIChatCompletionsReasoningItem = (item: OpenAIChatCompletionsReasoningSourceItem): OpenAIChatCompletionsReasoningItem => ({
  type: 'reasoning',
  ...(item.id == null ? {} : { id: item.id }),
  summary: item.summary,
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

export const translateOpenAIChatCompletionsReasoningItems = <T extends OpenAIResponsesReasoningItem>(reasoningItems: OpenAIChatCompletionsReasoningItem[] | null | undefined): T[] | null => {
  if (!reasoningItems?.length) return null;

  // `reasoning_items[]` is a LiteLLM-inspired compatibility workaround for
  // carrying multiple readable OpenAI Responses reasoning summaries through OpenAI Chat Completions.
  // Scalars remain first-group only.
  // References:
  // - https://github.com/BerriAI/litellm/blob/70492cee4282541256fb9ac963be94412b1a109c/litellm/completion_extras/litellm_responses_transformation/transformation.py#L59-L104
  // - https://github.com/BerriAI/litellm/blob/70492cee4282541256fb9ac963be94412b1a109c/litellm/completion_extras/litellm_responses_transformation/transformation.py#L1322-L1355
  const translated = reasoningItems.flatMap(item => (hasReadableSummary(item)
    ? [{ ...toOpenAIResponsesReasoningItem<T>(item), summary: klona(item.summary ?? []) } as T]
    : []));
  return translated.length > 0 ? translated : null;
};
