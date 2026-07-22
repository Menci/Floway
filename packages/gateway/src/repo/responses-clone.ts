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

export const persistedResponsesKey = (apiKeyId: string, stateEpoch: string, id: string): string =>
  `${apiKeyId}\0${stateEpoch}\0${id}`;

export const compareResponsesItemsByFreshness = (
  a: Pick<StoredResponsesItem, 'id' | 'refreshedAt'>,
  b: Pick<StoredResponsesItem, 'id' | 'refreshedAt'>,
): number =>
  b.refreshedAt - a.refreshedAt || a.id.localeCompare(b.id);

export const assertSameStoredResponsesItem = (
  expected: StoredResponsesItem,
  actual: StoredResponsesItem,
): void => {
  if (
    expected.id !== actual.id
    || expected.apiKeyId !== actual.apiKeyId
    || expected.contentHash !== actual.contentHash
    || expected.payloadHash !== actual.payloadHash
    || !isEqual(expected.payload, actual.payload)
  ) {
    throw new Error(`Responses item id collision: ${expected.id}`);
  }
};
