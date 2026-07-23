import { expect, test } from 'vitest';

import { createResponsesStorageKey, hashResponsesItemContent, responsesItemId } from './identity.ts';

test('reads arbitrary non-empty producer ids without format filtering', () => {
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

test('content hashing includes the producer item id', async () => {
  const first = await hashResponsesItemContent({ type: 'message', id: 'msg_a', role: 'user', content: 'same' });
  const second = await hashResponsesItemContent({ type: 'message', id: 'msg_b', role: 'user', content: 'same' });

  expect(first).not.toBe(second);
});
