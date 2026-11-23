import { expect, test } from 'vitest';

import { headersForAnthropicMessagesCall } from '../src/anthropic-messages.ts';

test('headersForAnthropicMessagesCall replaces an ordinary collision with ordered typed beta tokens', () => {
  const ordinary: [string, string][] = [['anthropic-beta', 'ordinary-must-not-win'], ['x-request-id', 'request-1']];
  const headers = headersForAnthropicMessagesCall(ordinary, ['context-1m', 'advanced-tool-use']);

  expect(headers).toEqual([
    ['anthropic-beta', 'context-1m,advanced-tool-use'],
    ['x-request-id', 'request-1'],
    ['anthropic-version', '2023-06-01'],
  ]);
  expect(ordinary[0][1]).toBe('ordinary-must-not-win');
});

test('headersForAnthropicMessagesCall removes empty beta tokens and sets the version in place', () => {
  expect(headersForAnthropicMessagesCall([
    ['anthropic-beta', 'ordinary-must-not-survive'], ['Anthropic-Version', 'previous'], ['x-request-id', 'request-1'],
  ], [])).toEqual([
    ['Anthropic-Version', '2023-06-01'],
    ['x-request-id', 'request-1'],
  ]);
});
