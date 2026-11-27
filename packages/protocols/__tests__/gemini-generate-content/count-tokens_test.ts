import { expect, test } from 'vitest';

import { parseJSONWithRawNumbers } from '../../src/common/json.ts';
import { decodeGeminiGenerateContentCountTokensResult } from '../../src/gemini-generate-content/index.ts';

test('Gemini countTokens preserves extensions and checks totalTokens', () => {
  const valid = { totalTokens: 2, cachedContentTokenCount: 1 };
  expect(decodeGeminiGenerateContentCountTokensResult(valid)).toEqual({ ok: true, value: valid });
  for (const invalid of [{}, { totalTokens: -1 }, { totalTokens: '3' }, { totalTokens: 2.5 }]) {
    expect(decodeGeminiGenerateContentCountTokensResult(invalid)).toMatchObject({ ok: false, error: expect.any(Error) });
  }
});

test('Gemini countTokens normalizes its known count and preserves unknown numeric tokens', () => {
  const text = '{"totalTokens":1.0,"cachedContentTokenCount":2e0}';
  expect(decodeGeminiGenerateContentCountTokensResult(JSON.parse(text)).ok).toBe(true);
  const decoded = decodeGeminiGenerateContentCountTokensResult(parseJSONWithRawNumbers(text));
  if (!decoded.ok) throw decoded.error;
  expect(decoded.value.totalTokens).toBe(1);
  expect(JSON.stringify(decoded.value)).toBe('{"totalTokens":1,"cachedContentTokenCount":2e0}');
});
