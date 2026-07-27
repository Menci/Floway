import { expect, test } from 'vitest';

import { createResponsesStorageKey, hashResponsesItem, responsesItemId } from '../../../../../src/data-plane/chat/responses/items/identity.ts';

test('reads arbitrary non-empty item ids without format filtering', () => {
  expect(responsesItemId({ id: 'raw/provider:id' })).toBe('raw/provider:id');
  expect(responsesItemId({ id: '' })).toBeNull();
  expect(responsesItemId({ type: 'message' })).toBeNull();
});

test('creates collision-resistant internal keys for idless stored inputs', () => {
  const first = createResponsesStorageKey();
  const second = createResponsesStorageKey();
  expect(first).toMatch(/^stored_.+$/);
  expect(second).toMatch(/^stored_.+$/);
  expect(second).not.toBe(first);
});

test('item hashing includes the item id', async () => {
  const first = await hashResponsesItem({ type: 'message', id: 'msg_a', role: 'user', content: 'same' });
  const second = await hashResponsesItem({ type: 'message', id: 'msg_b', role: 'user', content: 'same' });

  expect(first).not.toBe(second);
});
