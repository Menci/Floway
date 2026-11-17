import { expect, test } from 'vitest';

import { cachedTokenConventionFromTotals, foldsExclusiveCacheTokens } from '../../../../src/data-plane/shared/telemetry/usage.ts';
import { assertEquals } from '@floway-dev/test-utils';

const counts = (overrides: Partial<Parameters<typeof foldsExclusiveCacheTokens>[1]> = {}) => ({
  inputTokens: 479,
  outputTokens: 373,
  totalTokens: 14164 as number | undefined,
  cacheRead: 13312,
  cacheWrite: 0,
  ...overrides,
});

test('the exclusive sum reaching total_tokens witnesses the exclusive convention', () => {
  // 479 + 13312 + 373 = 14164, and 479 + 373 does not.
  assertEquals(cachedTokenConventionFromTotals(counts()), 'exclusive');
});

test('the inclusive sum reaching total_tokens witnesses the inclusive convention', () => {
  assertEquals(
    cachedTokenConventionFromTotals({ inputTokens: 1000, outputTokens: 50, totalTokens: 1050, cacheRead: 400, cacheWrite: 0 }),
    'inclusive',
  );
});

test('a declaration the totals contradict raises rather than over-charging', () => {
  expect(() => foldsExclusiveCacheTokens(
    true,
    { inputTokens: 1000, outputTokens: 50, totalTokens: 1050, cacheRead: 400, cacheWrite: 0 },
    'up/model',
  )).toThrowError(/over-charge input by 400 tokens/);
});

test('an unexplained underflow raises naming the flag and the upstream', () => {
  expect(() => foldsExclusiveCacheTokens(false, counts({ totalTokens: undefined }), 'up/model'))
    .toThrowError(/enable usage-exclusive-cached-tokens for up\/model/);
});
