import { expect, test } from 'vitest';

import { formatAnthropicMessagesError } from '../../src/anthropic-messages/error.ts';

test('formats an upstream failure without a native Messages error type', () => {
  const expected = { type: 'error', error: { type: 'api_error', message: 'upstream failure' } };
  expect(formatAnthropicMessagesError(429, 'upstream failure')).toEqual(expected);
  expect(formatAnthropicMessagesError(null, 'upstream failure')).toEqual(expected);
});
