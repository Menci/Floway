import type { ChatCompletionsReasoningItem } from '@floway-dev/protocols/chat-completions';
import { createRandomResponsesItemId, type ResponsesInputItem, type ResponsesOutputReasoning, type ResponsesReasoningItem } from '@floway-dev/protocols/responses';

export type ChatCompletionsReasoningSourceItem = Extract<ResponsesInputItem, { type: 'reasoning' }> | ResponsesOutputReasoning;

export interface ChatCompletionsReasoningProjection {
  items: ChatCompletionsReasoningItem[];
  text?: string;
  opaque?: string;
}

export const createChatCompletionsReasoningProjection = (): ChatCompletionsReasoningProjection => ({
  items: [],
});

export const toChatCompletionsReasoningItem = (item: ChatCompletionsReasoningSourceItem): ChatCompletionsReasoningItem => ({
  type: 'reasoning',
  id: item.id,
  summary: item.summary,
});

export const addResponsesReasoningToChatCompletionsProjection = (projection: ChatCompletionsReasoningProjection, item: ChatCompletionsReasoningSourceItem): void => {
  projection.items.push(toChatCompletionsReasoningItem(item));

  const text = item.summary.map(part => part.text).join('');
  if (projection.text === undefined && projection.opaque === undefined && (text || item.encrypted_content !== undefined)) {
    if (text) projection.text = text;
    if (item.encrypted_content !== undefined) projection.opaque = item.encrypted_content;
  }
};

export const chatCompletionsReasoningProjectionFields = (projection: ChatCompletionsReasoningProjection) => ({
  ...(projection.text !== undefined ? { reasoning_text: projection.text } : {}),
  ...(projection.opaque !== undefined ? { reasoning_opaque: projection.opaque } : {}),
  ...(projection.items.length > 0 ? { reasoning_items: projection.items } : {}),
});

export const toResponsesReasoningItem = <T extends ResponsesReasoningItem>(item: ChatCompletionsReasoningItem): T =>
  ({
    type: 'reasoning',
    id: item.id ?? createRandomResponsesItemId('reasoning'),
    summary: item.summary ?? [],
  } as T);

export const scalarToResponsesReasoningItem = <T extends ResponsesReasoningItem>(
  reasoningText: string | null | undefined,
  reasoningOpaque?: string | null,
): T | null => {
  if (!reasoningText && (reasoningOpaque === undefined || reasoningOpaque === null)) return null;

  return {
    type: 'reasoning',
    id: createRandomResponsesItemId('reasoning'),
    summary: reasoningText ? [{ type: 'summary_text', text: reasoningText }] : [],
    ...(reasoningOpaque !== undefined && reasoningOpaque !== null ? { encrypted_content: reasoningOpaque } : {}),
  } as T;
};

export const hasReadableSummary = (item: ChatCompletionsReasoningItem): boolean => item.summary?.some(part => part.text) === true;

export const translateChatCompletionsReasoningItems = <T extends ResponsesReasoningItem>(reasoningItems: ChatCompletionsReasoningItem[] | null | undefined): T[] | null => {
  if (!reasoningItems?.length) return null;

  // `reasoning_items[]` is a LiteLLM-inspired compatibility workaround for
  // carrying multiple readable Responses reasoning summaries through Chat.
  // Scalars remain first-group only.
  // References:
  // - https://github.com/BerriAI/litellm/blob/70492cee4282541256fb9ac963be94412b1a109c/litellm/completion_extras/litellm_responses_transformation/transformation.py#L59-L104
  // - https://github.com/BerriAI/litellm/blob/70492cee4282541256fb9ac963be94412b1a109c/litellm/completion_extras/litellm_responses_transformation/transformation.py#L1322-L1355
  const translated = reasoningItems.flatMap(item => (hasReadableSummary(item) ? [toResponsesReasoningItem<T>(item)] : []));
  return translated.length > 0 ? translated : null;
};
