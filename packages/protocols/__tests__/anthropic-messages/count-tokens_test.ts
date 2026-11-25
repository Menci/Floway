import { expect, test } from 'vitest';

import { decodeAnthropicMessagesCountTokensResult } from '../../src/anthropic-messages/index.ts';

test('keeps zero input tokens and extra count_tokens fields', () => {
  const body = { input_tokens: 0, upstream_extension: { kept: true } };
  const decoded = decodeAnthropicMessagesCountTokensResult(body);
  if (!decoded.ok) throw decoded.error;
  expect(decoded.value).toBe(body);
});

test.each([undefined, null, '1', -1, 0.5, Infinity])('rejects invalid input_tokens %s', input_tokens => {
  expect(decodeAnthropicMessagesCountTokensResult({ input_tokens })).toMatchObject({ ok: false, error: expect.any(Error) });
});
