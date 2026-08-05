import { expect, test } from 'vitest';

import { headersForMessagesCall } from '../src/messages.ts';

test('headersForMessagesCall serializes ordered beta tokens onto a fresh ordinary-header bag', () => {
  const ordinary = new Headers({ 'x-request-id': 'request-1' });
  const headers = headersForMessagesCall(ordinary, ['context-1m', 'advanced-tool-use']);

  expect(Object.fromEntries(headers)).toEqual({
    'anthropic-beta': 'context-1m,advanced-tool-use',
    'x-request-id': 'request-1',
  });
  expect(ordinary.has('anthropic-beta')).toBe(false);
});

test('headersForMessagesCall omits anthropic-beta when the typed token list is empty', () => {
  expect(Object.fromEntries(headersForMessagesCall(new Headers({ 'x-request-id': 'request-1' }), []))).toEqual({
    'x-request-id': 'request-1',
  });
});
