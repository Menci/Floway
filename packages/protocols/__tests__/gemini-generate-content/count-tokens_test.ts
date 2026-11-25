import { expect, test } from 'vitest';

import { decodeGeminiGenerateContentCountTokensResult } from '../../src/gemini-generate-content/index.ts';

test('keeps the count and extra countTokens fields', () => {
  const body = { totalTokens: 7, cachedContentTokenCount: 2, upstream_extension: true };
  const decoded = decodeGeminiGenerateContentCountTokensResult(body);
  if (!decoded.ok) throw decoded.error;
  expect(decoded.value).toBe(body);
});

test.each([undefined, null, '1', -1, 0.5, Infinity])('rejects invalid totalTokens %s', totalTokens => {
  expect(decodeGeminiGenerateContentCountTokensResult({ totalTokens })).toMatchObject({ ok: false, error: expect.any(Error) });
});
