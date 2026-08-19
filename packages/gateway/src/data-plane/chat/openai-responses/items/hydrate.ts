import { openaiResponsesItemId } from './identity.ts';
import type { OpenAIResponsesStatefulStore } from './store.ts';
import { throwChatServeFailure } from '../../shared/errors.ts';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesInputItem } from '@floway-dev/protocols/openai-responses';

interface HydratedItem {
  readonly item: OpenAIResponsesInputItem;
  readonly privatePayload?: { readonly id: string; readonly value: unknown };
}

const hydrateItem = (item: OpenAIResponsesInputItem, store: OpenAIResponsesStatefulStore): HydratedItem => {
  const id = openaiResponsesItemId(item);
  if (id === null) return { item };
  const stored = store.getItemById(id);
  if (stored === undefined) {
    if (item.type === 'item_reference') throwChatServeFailure({ kind: 'item-not-found', itemId: id });
    return { item };
  }
  return {
    item: stored.payload.item as OpenAIResponsesInputItem,
    ...(stored.payload.private !== undefined
      ? { privatePayload: { id: stored.id, value: stored.payload.private } }
      : {}),
  };
};

interface HydratedOpenAIResponsesPayload {
  readonly payload: CanonicalOpenAIResponsesPayload;
  readonly privatePayloads: ReadonlyMap<string, unknown>;
}

export const hydrateOpenAIResponsesPayload = (
  payload: CanonicalOpenAIResponsesPayload,
  store: OpenAIResponsesStatefulStore,
): HydratedOpenAIResponsesPayload => {
  const hydrated = payload.input.map(item => hydrateItem(item, store));
  const privatePayloads = new Map<string, unknown>();
  for (const entry of hydrated) {
    if (entry.privatePayload !== undefined) {
      privatePayloads.set(entry.privatePayload.id, entry.privatePayload.value);
    }
  }
  return {
    payload: { ...payload, input: hydrated.map(entry => entry.item) },
    privatePayloads,
  };
};
