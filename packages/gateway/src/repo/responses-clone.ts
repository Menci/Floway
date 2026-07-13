import type { StoredResponsesItem, StoredResponsesItemMetadata, StoredResponsesSnapshot } from './types.ts';

export const cloneStoredResponsesItem = (item: StoredResponsesItem): StoredResponsesItem => ({
  ...item,
  payload: item.payload === null ? null : structuredClone(item.payload),
});

export const storedResponsesItemMetadata = (item: StoredResponsesItem): StoredResponsesItemMetadata => {
  const { payload, ...metadata } = item;
  return { ...metadata, hasPayload: payload !== null };
};

export const cloneStoredResponsesItemMetadata = (item: StoredResponsesItemMetadata): StoredResponsesItemMetadata => ({ ...item });

export const cloneStoredResponsesSnapshot = (snapshot: StoredResponsesSnapshot): StoredResponsesSnapshot => ({
  ...snapshot,
  itemIds: [...snapshot.itemIds],
});

export const responsesItemStoreKey = (apiKeyId: string | null, id: string): string =>
  `${apiKeyId ?? ''}\0${id}`;

export const compareResponsesItemsByFreshness = (
  a: Pick<StoredResponsesItemMetadata, 'id' | 'createdAt' | 'refreshedAt'>,
  b: Pick<StoredResponsesItemMetadata, 'id' | 'createdAt' | 'refreshedAt'>,
): number =>
  b.refreshedAt - a.refreshedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id);
