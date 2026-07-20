import { expect, test } from 'vitest';

import { createResponsesResponseId, isResponsesResponseId } from './response-id.ts';

test('creates unique verifiable Floway response envelope ids', () => {
  const first = createResponsesResponseId();
  const second = createResponsesResponseId();

  expect(isResponsesResponseId(first)).toBe(true);
  expect(isResponsesResponseId(second)).toBe(true);
  expect(second).not.toBe(first);
  expect(isResponsesResponseId(`${first}x`)).toBe(false);
  expect(isResponsesResponseId(first.replace('resp_', 'msg_'))).toBe(false);
});
