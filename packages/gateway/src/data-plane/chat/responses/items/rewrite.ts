import { canonicalResponsesItemType, isResponsesItemId, responsesItemId } from './format.ts';
import type { StatefulResponsesStore } from './store.ts';
import { throwChatServeFailure } from '../../shared/errors.ts';
import type { CanonicalResponsesPayload, ResponsesInputItem } from '@floway-dev/protocols/responses';

interface HydratedItem {
  readonly item: ResponsesInputItem;
  readonly privatePayload?: unknown;
}

const hydrateItem = (item: ResponsesInputItem, store: StatefulResponsesStore | undefined): HydratedItem => {
  const id = responsesItemId(item);
  if (id === null || !isResponsesItemId(id)) return { item };
  const stored = store?.getItemById(id);
  if (stored === undefined) {
    if (item.type === 'item_reference') throwChatServeFailure({ kind: 'item-not-found', itemId: id });
    return { item };
  }
  if (item.type !== 'item_reference' && canonicalResponsesItemType(item.type) !== canonicalResponsesItemType(stored.itemType)) {
    throwChatServeFailure({
      kind: 'routing-unavailable',
      message: `Stored Responses item '${stored.id}' has type '${stored.itemType}', incompatible with the requested item type '${item.type}'.`,
    });
  }
  return {
    item: structuredClone(stored.payload.item) as ResponsesInputItem,
    ...(stored.payload.private !== undefined ? { privatePayload: structuredClone(stored.payload.private) } : {}),
  };
};

export interface HydratedResponsesPayload {
  readonly payload: CanonicalResponsesPayload;
  readonly privatePayloads: ReadonlyMap<string, unknown>;
}

export const hydrateResponsesPayload = (
  payload: CanonicalResponsesPayload,
  store: StatefulResponsesStore | undefined,
): HydratedResponsesPayload => {
  const hydrated = payload.input.map(item => hydrateItem(item, store));
  const privatePayloads = new Map<string, unknown>();
  for (const entry of hydrated) {
    const id = responsesItemId(entry.item);
    if (id !== null && entry.privatePayload !== undefined) privatePayloads.set(id, entry.privatePayload);
  }
  return {
    payload: { ...payload, input: hydrated.map(entry => entry.item) },
    privatePayloads,
  };
};
