import { expect, test } from 'vitest';

import { headersForAnthropicMessagesCall } from '../src/anthropic-messages.ts';

test('headersForAnthropicMessagesCall replaces an ordinary collision with ordered typed beta tokens', () => {
  const ordinary: [string, string][] = [['anthropic-beta', 'ordinary-must-not-win'], ['x-request-id', 'request-1']];
  const headers = headersForAnthropicMessagesCall(ordinary, ['context-1m', 'advanced-tool-use']);

  expect(headers).toEqual([
    ['x-request-id', 'request-1'],
    ['anthropic-beta', 'context-1m,advanced-tool-use'],
  ]);
  expect(ordinary[0][1]).toBe('ordinary-must-not-win');
});

test('headersForAnthropicMessagesCall removes an ordinary collision when the typed token list is empty', () => {
  expect(headersForAnthropicMessagesCall([['anthropic-beta', 'ordinary-must-not-survive'], ['x-request-id', 'request-1']], [])).toEqual([
    ['x-request-id', 'request-1'],
  ]);
});

test('headersForAnthropicMessagesCall keeps every other repeated name', () => {
  expect(headersForAnthropicMessagesCall([['x-route', 'one'], ['anthropic-beta', 'dropped'], ['x-route', 'two']], ['context-1m'])).toEqual([
    ['x-route', 'one'],
    ['x-route', 'two'],
    ['anthropic-beta', 'context-1m'],
  ]);
});
