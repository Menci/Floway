import { responsesItemId } from './identity.ts';
import type { StatefulResponsesStore } from './store.ts';
import { throwChatServeFailure } from '../../shared/errors.ts';
import type { CanonicalResponsesPayload, ResponsesInputItem } from '@floway-dev/protocols/responses';

interface HydratedItem {
  readonly item: ResponsesInputItem;
  readonly privatePayload?: { readonly id: string; readonly value: unknown };
}

const hydrateItem = (item: ResponsesInputItem, store: StatefulResponsesStore): HydratedItem => {
  const id = responsesItemId(item);
  if (id === null) return { item };
  const stored = store.getItemById(id);
  if (stored === undefined) {
    if (item.type === 'item_reference') throwChatServeFailure({ kind: 'item-not-found', itemId: id });
    return { item };
  }
  return {
    item: stored.payload.item as ResponsesInputItem,
    ...(stored.payload.private !== undefined
      ? { privatePayload: { id: stored.id, value: stored.payload.private } }
      : {}),
  };
};

interface HydratedResponsesPayload {
  readonly payload: CanonicalResponsesPayload;
  readonly privatePayloads: ReadonlyMap<string, unknown>;
}

export const hydrateResponsesPayload = (
  payload: CanonicalResponsesPayload,
  store: StatefulResponsesStore,
): HydratedResponsesPayload => {
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
