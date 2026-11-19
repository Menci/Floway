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
  )).toThrowError(/over-charge/);
});

test('an unexplained underflow raises', () => {
  expect(() => foldsExclusiveCacheTokens(false, counts({ totalTokens: undefined }), 'up/model'))
    .toThrowError(/enable usage-exclusive-cached-tokens/);
});
