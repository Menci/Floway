import { expect, test } from 'vitest';

import { decodeAnthropicMessagesCountTokensResult } from '../../src/anthropic-messages/index.ts';
import { parseJSONWithRawNumbers } from '../../src/common/json.ts';

test('Anthropic Messages count_tokens preserves extensions and checks input_tokens', () => {
  const valid = { input_tokens: 0, vendor_count: 7 };
  expect(decodeAnthropicMessagesCountTokensResult(valid)).toEqual({ ok: true, value: valid });
  for (const invalid of [{}, { input_tokens: -1 }, { input_tokens: '3' }, { input_tokens: 2.5 }]) {
    expect(decodeAnthropicMessagesCountTokensResult(invalid)).toMatchObject({ ok: false, error: expect.any(Error) });
  }
});

test('Anthropic Messages count_tokens normalizes its known count and preserves unknown numeric tokens', () => {
  const text = '{"input_tokens":1e0,"vendor_count":2e0}';
  expect(decodeAnthropicMessagesCountTokensResult(JSON.parse(text)).ok).toBe(true);
  const decoded = decodeAnthropicMessagesCountTokensResult(parseJSONWithRawNumbers(text));
  if (!decoded.ok) throw decoded.error;
  expect(decoded.value.input_tokens).toBe(1);
  expect(JSON.stringify(decoded.value)).toBe('{"input_tokens":1,"vendor_count":2e0}');
});
