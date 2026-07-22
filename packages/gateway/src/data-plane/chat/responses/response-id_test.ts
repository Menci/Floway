import { expect, test } from 'vitest';

import { createResponsesResponseId } from './response-id.ts';

test('creates unique opaque Floway response envelope ids', () => {
  const first = createResponsesResponseId();
  const second = createResponsesResponseId();

  expect(first).toMatch(/^resp_[0-9a-f]{32}$/u);
  expect(second).toMatch(/^resp_[0-9a-f]{32}$/u);
  expect(second).not.toBe(first);
});
