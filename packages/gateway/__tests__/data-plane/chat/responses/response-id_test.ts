import { expect, test } from 'vitest';

import { createResponsesResponseId } from '../../../../src/data-plane/chat/responses/response-id.ts';

test('creates distinct opaque response envelope ids', () => {
  const first = createResponsesResponseId();
  const second = createResponsesResponseId();

  expect(first).toMatch(/^resp_.+$/u);
  expect(second).toMatch(/^resp_.+$/u);
  expect(second).not.toBe(first);
});
