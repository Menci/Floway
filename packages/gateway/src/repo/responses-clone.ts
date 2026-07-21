import { isEqual } from 'es-toolkit';

import type { StoredResponsesItem, StoredResponsesSnapshot } from './types.ts';

export const cloneStoredResponsesItem = (item: StoredResponsesItem): StoredResponsesItem => ({
  ...item,
  payload: structuredClone(item.payload),
});

export const cloneStoredResponsesSnapshot = (snapshot: StoredResponsesSnapshot): StoredResponsesSnapshot => ({
  ...snapshot,
  itemIds: [...snapshot.itemIds],
});

export const scopedResponsesKey = (apiKeyId: string, id: string): string => `${apiKeyId}\0${id}`;

export const compareResponsesItemsByFreshness = (
  a: Pick<StoredResponsesItem, 'id' | 'createdAt'>,
  b: Pick<StoredResponsesItem, 'id' | 'createdAt'>,
): number =>
  b.createdAt - a.createdAt || a.id.localeCompare(b.id);

export const assertSameStoredResponsesItem = (
  expected: StoredResponsesItem,
  actual: StoredResponsesItem,
): void => {
  const expectedIdentity = expected.payload.identity ?? expected.payload.item;
  const actualIdentity = actual.payload.identity ?? actual.payload.item;
  if (
    expected.id !== actual.id
    || expected.apiKeyId !== actual.apiKeyId
    || expected.contentHash !== actual.contentHash
    || !isEqual(expectedIdentity, actualIdentity)
    || !isEqual(expected.payload.private, actual.payload.private)
  ) {
    throw new Error(`Responses item id collision: ${expected.id}`);
  }
};
