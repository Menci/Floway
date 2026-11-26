import { openaiResponsesItemId } from './identity.ts';
import type { OpenAIResponsesStatefulStore } from './store.ts';
import { throwChatServeFailure } from '../../shared/errors.ts';
import type { CanonicalOpenAIResponsesInputItem } from '@floway-dev/protocols/openai-responses';

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

export const hydrateOpenAIResponsesPayload = <Payload extends { input: CanonicalOpenAIResponsesInputItem[] }>(
  payload: Payload,
  store: OpenAIResponsesStatefulStore,
): Payload => {
  let changed = false;
  const input = payload.input.map(item => {
    const hydrated = hydrateItem(item, store);
    changed ||= hydrated !== item;
    return hydrated;
  });
  return changed ? { ...payload, input } : payload;
};
