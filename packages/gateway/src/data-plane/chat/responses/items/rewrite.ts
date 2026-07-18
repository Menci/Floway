import { isResponsesItemId, responsesItemId } from './format.ts';
import type { StatefulResponsesStore } from './store.ts';
import { throwChatServeFailure } from '../../shared/errors.ts';
import type { CanonicalResponsesPayload, ResponsesInputItem } from '@floway-dev/protocols/responses';
import type { ModelCandidate } from '@floway-dev/provider';

interface HydratedItem {
  readonly item: ResponsesInputItem;
  readonly privatePayload?: unknown;
}

const hydrateItem = (item: ResponsesInputItem, store: StatefulResponsesStore): HydratedItem => {
  const id = responsesItemId(item);
  if (id === null || !isResponsesItemId(id)) return { item };
  const stored = store.getItemById(id);
  if (stored === undefined) {
    if (item.type === 'item_reference') throwChatServeFailure({ kind: 'item-not-found', itemId: id });
    return { item };
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
  store: StatefulResponsesStore,
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

export interface RewrittenResponsesItems {
  readonly payload: CanonicalResponsesPayload;
  readonly privatePayloads: ReadonlyMap<string, unknown>;
}

export const rewriteResponsesItemsForCandidate = (
  payload: CanonicalResponsesPayload,
  privatePayloads: ReadonlyMap<string, unknown>,
  store: StatefulResponsesStore,
  candidate: ModelCandidate,
): RewrittenResponsesItems => {
  const restoredIds = new Map<string, string>();
  const input = payload.input.map(item => {
    const id = responsesItemId(item);
    if (id === null || !isResponsesItemId(id)) return item;
    const stored = store.getItemById(id);
    if (
      stored?.upstreamId !== candidate.provider.upstream
      || stored.upstreamItemId === null
    ) return item;
    restoredIds.set(id, stored.upstreamItemId);
    return { ...item, id: stored.upstreamItemId } as ResponsesInputItem;
  });
  return {
    payload: { ...payload, input },
    privatePayloads: new Map(
      [...privatePayloads].map(([id, value]) => [restoredIds.get(id) ?? id, structuredClone(value)]),
    ),
  };
};
