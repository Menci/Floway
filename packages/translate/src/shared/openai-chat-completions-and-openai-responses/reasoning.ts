import { klona } from 'klona/json';

import type { OpenAIChatCompletionsReasoningItem } from '@floway-dev/protocols/openai-chat-completions';
import { createRandomOpenAIResponsesItemId, type OpenAIResponsesInputReasoning, type OpenAIResponsesInputItem, type OpenAIResponsesOutputReasoning } from '@floway-dev/protocols/openai-responses';

// OpenAI's Chat Completions spec has no reasoning-text field; upstreams expose
// the same quantity as `reasoning_content` or `reasoning`. Treat both as
// aliases of the gateway's canonical `reasoning_text`, preferring the canonical
// name when an upstream emits more than one.

export interface OpenAIChatCompletionsReasoningDeltaAliases {
  reasoning_text?: string | null;
  reasoning_content?: string | null;
  reasoning?: string | null;
}

// Precedence: `reasoning_text` > `reasoning_content` > `reasoning`. Only a
// non-empty string carries reasoning; a `null` field (an upstream filler
// between reasoning and content chunks) is not reasoning.
export const openAIChatCompletionsScalarReasoningText = (delta: OpenAIChatCompletionsReasoningDeltaAliases): string | undefined => {
  if (typeof delta.reasoning_text === 'string' && delta.reasoning_text.length > 0) return delta.reasoning_text;
  if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) return delta.reasoning_content;
  if (typeof delta.reasoning === 'string' && delta.reasoning.length > 0) return delta.reasoning;
  return undefined;
};

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

// Input history does not invent a stored upstream identity. Output items still
// require their own ID, independently of whether encrypted content is present.
// https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/public/openapi/openapi.json#/components/schemas/ReasoningItemParam
export const toOpenAIResponsesInputReasoningItem = (item: OpenAIChatCompletionsReasoningItem): OpenAIResponsesInputReasoning => ({
  type: 'reasoning',
  ...(item.id !== undefined ? { id: item.id } : {}),
  summary: item.summary ?? [],
});

export const toOpenAIResponsesOutputReasoningItem = (item: OpenAIChatCompletionsReasoningItem): OpenAIResponsesOutputReasoning => ({
  ...toOpenAIResponsesInputReasoningItem(item),
  id: item.id ?? createRandomOpenAIResponsesItemId('reasoning'),
});

export const scalarToOpenAIResponsesReasoningItem = (reasoningText: string | null | undefined): OpenAIResponsesInputReasoning | null => {
  if (!reasoningText) return null;
  return { type: 'reasoning', summary: [{ type: 'summary_text', text: reasoningText }] };
};

export const hasReadableSummary = (item: OpenAIChatCompletionsReasoningItem): boolean => item.summary?.some(part => part.text) === true;

export const translateOpenAIChatCompletionsReasoningItems = (reasoningItems: OpenAIChatCompletionsReasoningItem[] | null | undefined): OpenAIResponsesInputReasoning[] | null => {
  if (!reasoningItems?.length) return null;

  // `reasoning_items[]` is a LiteLLM-inspired compatibility workaround for
  // carrying multiple readable OpenAI Responses reasoning summaries through OpenAI Chat Completions.
  // Scalars remain first-group only.
  // References:
  // - https://github.com/BerriAI/litellm/blob/70492cee4282541256fb9ac963be94412b1a109c/litellm/completion_extras/litellm_responses_transformation/transformation.py#L59-L104
  // - https://github.com/BerriAI/litellm/blob/70492cee4282541256fb9ac963be94412b1a109c/litellm/completion_extras/litellm_responses_transformation/transformation.py#L1322-L1355
  const translated = reasoningItems.flatMap(item => (hasReadableSummary(item)
    ? [{ ...toOpenAIResponsesInputReasoningItem(item), summary: klona(item.summary ?? []) }]
    : []));
  return translated.length > 0 ? translated : null;
};
