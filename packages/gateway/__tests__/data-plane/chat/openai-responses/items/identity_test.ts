import { expect, test } from 'vitest';

import { openaiResponsesItemId } from '../../../../../src/data-plane/chat/openai-responses/items/identity.ts';

test('reads arbitrary non-empty item ids without format filtering', () => {
  expect(openaiResponsesItemId({ id: 'raw/provider:id' })).toBe('raw/provider:id');
  expect(openaiResponsesItemId({ id: '' })).toBeNull();
  expect(openaiResponsesItemId({ type: 'message' })).toBeNull();
});
