import { expect, test } from 'vitest';

import { foldsExclusiveCacheTokens } from '../../../../src/data-plane/shared/telemetry/usage.ts';

const counts = (overrides: Partial<Parameters<typeof foldsExclusiveCacheTokens>[1]> = {}) => ({
  inputTokens: 479,
  outputTokens: 373,
  totalTokens: 14164 as number | undefined,
  cacheRead: 13312,
  cacheWrite: 0,
  ...overrides,
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
