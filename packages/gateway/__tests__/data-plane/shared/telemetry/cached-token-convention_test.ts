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

test('the cache buckets are counted together when deciding which sum matches', () => {
  assertEquals(
    cachedTokenConventionFromTotals({ inputTokens: 100, outputTokens: 10, totalTokens: 310, cacheRead: 120, cacheWrite: 80 }),
    'exclusive',
  );
});

test('a zero cache count leaves the two conventions indistinguishable', () => {
  // Both sums are the same number, and both conventions bill the same way.
  assertEquals(cachedTokenConventionFromTotals({ ...counts(), cacheRead: 0, cacheWrite: 0, totalTokens: 852 }), null);
});

test('a withheld total witnesses nothing', () => {
  assertEquals(cachedTokenConventionFromTotals(counts({ totalTokens: undefined })), null);
});

test('a total computed on some third basis witnesses nothing', () => {
  assertEquals(cachedTokenConventionFromTotals(counts({ totalTokens: 99999 })), null);
});

test('positive evidence folds without a declaration', () => {
  assertEquals(foldsExclusiveCacheTokens(false, counts(), 'up/model'), true);
});

test('a declaration folds where the totals witness nothing', () => {
  assertEquals(foldsExclusiveCacheTokens(true, counts({ totalTokens: undefined }), 'up/model'), true);
});

test('an inclusive response with no declaration is left alone', () => {
  assertEquals(
    foldsExclusiveCacheTokens(false, { inputTokens: 1000, outputTokens: 50, totalTokens: 1050, cacheRead: 400, cacheWrite: 0 }, 'up/model'),
    false,
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

test('a cache count within the input total is left to the split when nothing witnesses otherwise', () => {
  // No verdict and no underflow: the response is indistinguishable from an
  // ordinary inclusive one, and billing it as such is what the two
  // conventions agree on for everything except the cached bucket itself.
  assertEquals(
    foldsExclusiveCacheTokens(false, { inputTokens: 1000, outputTokens: 50, totalTokens: 99999, cacheRead: 400, cacheWrite: 0 }, 'up/model'),
    false,
  );
});
