import { expect, test } from 'vitest';

import { tokenUsageFromGeminiUsageMetadata } from './usage.ts';
import { USAGE_BILLING } from '@floway-dev/protocols/common';

test('Gemini usage records translated cache writes and service tier', () => {
  expect(tokenUsageFromGeminiUsageMetadata({
    promptTokenCount: 100,
    cachedContentTokenCount: 30,
    candidatesTokenCount: 20,
    thoughtsTokenCount: 5,
    [USAGE_BILLING]: { cacheWriteTokenCount: 20, cacheWrite1hTokenCount: 5, serviceTier: 'priority' },
  })).toEqual({
    input: 45,
    input_cache_read: 30,
    input_cache_write: 20,
    input_cache_write_1h: 5,
    output: 25,
    tier: 'priority',
  });
});

test('Gemini usage rejects malformed translated cache splits', () => {
  expect(() => tokenUsageFromGeminiUsageMetadata({
    promptTokenCount: 40,
    cachedContentTokenCount: 30,
    [USAGE_BILLING]: { cacheWriteTokenCount: 25 },
  })).toThrowError(RangeError);
});
