import { expect, test } from 'vitest';

import { createOpenAIResponsesStorageKey, hashOpenAIResponsesItem, openaiResponsesItemId } from '../../../../../src/data-plane/chat/openai-responses/items/identity.ts';

test('reads arbitrary non-empty item ids without format filtering', () => {
  expect(openaiResponsesItemId({ id: 'raw/provider:id' })).toBe('raw/provider:id');
  expect(openaiResponsesItemId({ id: '' })).toBeNull();
  expect(openaiResponsesItemId({ type: 'message' })).toBeNull();
});

test('creates collision-resistant internal keys for idless stored inputs', () => {
  const first = createOpenAIResponsesStorageKey();
  const second = createOpenAIResponsesStorageKey();
  expect(first).toMatch(/^stored_.+$/);
  expect(second).toMatch(/^stored_.+$/);
  expect(second).not.toBe(first);
});

test('item hashing includes the item id', async () => {
  const first = await hashOpenAIResponsesItem({ type: 'message', id: 'msg_a', role: 'user', content: 'same' });
  const second = await hashOpenAIResponsesItem({ type: 'message', id: 'msg_b', role: 'user', content: 'same' });

  expect(first).not.toBe(second);
});
