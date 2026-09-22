import { isEqual } from 'es-toolkit';

import type { StoredOpenAIResponsesItem, StoredOpenAIResponsesSnapshot } from './types.ts';

export const cloneStoredOpenAIResponsesItem = (item: StoredOpenAIResponsesItem): StoredOpenAIResponsesItem => ({
  ...item,
  payload: structuredClone(item.payload),
});

export const cloneStoredOpenAIResponsesSnapshot = (snapshot: StoredOpenAIResponsesSnapshot): StoredOpenAIResponsesSnapshot => ({
  ...snapshot,
  itemIds: [...snapshot.itemIds],
});

export const scopedOpenAIResponsesKey = (apiKeyId: string, id: string): string => `${apiKeyId}\0${id}`;

export const compareOpenAIResponsesItemsByFreshness = (
  a: Pick<StoredOpenAIResponsesItem, 'id' | 'refreshedAt'>,
  b: Pick<StoredOpenAIResponsesItem, 'id' | 'refreshedAt'>,
): number =>
  b.refreshedAt - a.refreshedAt || a.id.localeCompare(b.id);

export const assertSameStoredOpenAIResponsesItem = (
  expected: StoredOpenAIResponsesItem,
  actual: StoredOpenAIResponsesItem,
): void => {
  if (
    expected.id !== actual.id
    || expected.apiKeyId !== actual.apiKeyId
    || expected.itemHash !== actual.itemHash
    || !isEqual(expected.payload, actual.payload)
  ) {
    throw new Error(`OpenAI Responses item id collision: ${expected.id}`);
  }
};
