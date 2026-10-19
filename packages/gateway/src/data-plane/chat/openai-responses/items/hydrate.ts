import { openaiResponsesItemId } from './identity.ts';
import type { OpenAIResponsesStatefulStore } from './store.ts';
import { throwChatServeFailure } from '../../shared/errors.ts';
import type { CanonicalOpenAIResponsesPayload, CanonicalOpenAIResponsesInputItem } from '@floway-dev/protocols/openai-responses';

const hydrateItem = (item: CanonicalOpenAIResponsesInputItem, store: OpenAIResponsesStatefulStore): CanonicalOpenAIResponsesInputItem => {
  const id = openaiResponsesItemId(item);
  if (id === null) return item;
  const stored = store.getItemById(id);
  if (stored === undefined) {
    if (item.type === 'item_reference') throwChatServeFailure({ kind: 'item-not-found', itemId: id });
    return item;
  }
  return stored.payload.item as CanonicalOpenAIResponsesInputItem;
};

export const hydrateOpenAIResponsesPayload = (
  payload: CanonicalOpenAIResponsesPayload,
  store: OpenAIResponsesStatefulStore,
): CanonicalOpenAIResponsesPayload => ({ ...payload, input: payload.input.map(item => hydrateItem(item, store)) });
