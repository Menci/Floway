import type { ChatReasoningItem } from '@floway-dev/protocols/chat-completions';
import type { ResponseInputItem, ResponseOutputReasoning, ResponsesReasoningItem } from '@floway-dev/protocols/responses';

export type ChatReasoningSourceItem = Extract<ResponseInputItem, { type: 'reasoning' }> | ResponseOutputReasoning;

export interface ChatReasoningProjection {
  items: ChatReasoningItem[];
  text?: string;
}

export const createChatReasoningProjection = (): ChatReasoningProjection => ({
  items: [],
});

export const toChatReasoningItem = (item: ChatReasoningSourceItem): ChatReasoningItem => ({
  type: 'reasoning',
  id: item.id,
  summary: item.summary,
});

export const addResponseReasoningToChatProjection = (projection: ChatReasoningProjection, item: ChatReasoningSourceItem): void => {
  projection.items.push(toChatReasoningItem(item));

  const text = item.summary.map(part => part.text).join('');
  if (projection.text === undefined && text) {
    if (text) projection.text = text;
  }
};

export const chatReasoningProjectionFields = (projection: ChatReasoningProjection) => ({
  ...(projection.text !== undefined ? { reasoning_text: projection.text } : {}),
  ...(projection.items.length > 0 ? { reasoning_items: projection.items } : {}),
});

export const toResponseReasoningItem = <T extends ResponsesReasoningItem>(item: ChatReasoningItem, fallbackId: string): T =>
  ({
    type: 'reasoning',
    id: item.id ?? fallbackId,
    summary: item.summary ?? [],
  } as T);

export const scalarToResponseReasoningItem = <T extends ResponsesReasoningItem>(reasoningText: string | null | undefined, id: string): T | null => {
  if (!reasoningText) return null;

  return {
    type: 'reasoning',
    id,
    summary: reasoningText ? [{ type: 'summary_text', text: reasoningText }] : [],
  } as T;
};

const hasReadableSummary = (item: ChatReasoningItem): boolean => item.summary?.some(part => part.text) === true;

export const translateChatReasoningItems = <T extends ResponsesReasoningItem>(reasoningItems: ChatReasoningItem[] | null | undefined, nextIdIndex: () => number): T[] | null => {
  if (!reasoningItems?.length) return null;

  // `reasoning_items[]` is a LiteLLM-inspired compatibility workaround for
  // carrying multiple readable Responses reasoning summaries through Chat.
  // Scalars remain first-group only.
  // References:
  // - https://github.com/BerriAI/litellm/blob/70492cee4282541256fb9ac963be94412b1a109c/litellm/completion_extras/litellm_responses_transformation/transformation.py#L59-L104
  // - https://github.com/BerriAI/litellm/blob/70492cee4282541256fb9ac963be94412b1a109c/litellm/completion_extras/litellm_responses_transformation/transformation.py#L1322-L1355
  const startIndex = nextIdIndex();
  const translated = reasoningItems.flatMap((item, index) => (hasReadableSummary(item) ? [toResponseReasoningItem<T>(item, `rs_${startIndex + index}`)] : []));
  return translated.length > 0 ? translated : null;
};
