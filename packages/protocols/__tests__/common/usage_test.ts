import { expect, test } from 'vitest';

import { billableServiceTier, splitCacheWriteTokens, splitInclusiveInputTokens, splitInclusiveOutputTokens, sumBillableUsage } from '../../src/common/usage.ts';

test('service-tier normalization preserves authored open strings and maps base markers to null', () => {
  expect(billableServiceTier(undefined)).toBeNull();
  expect(billableServiceTier(' Default ')).toBeNull();
  expect(billableServiceTier('\tstandard\n')).toBeNull();
  expect(billableServiceTier('  ')).toBeNull();
  expect(billableServiceTier(' Priority ')).toBe(' Priority ');
});

test('inclusive input usage splits cache reads and writes into disjoint counts', () => {
  expect(splitInclusiveInputTokens(100, 30, 25)).toEqual({ input: 45, cacheRead: 30, cacheWrite: 25 });
});

test.each([
  ['input tokens', -1, undefined, undefined],
  ['input tokens', Number.POSITIVE_INFINITY, undefined, undefined],
  ['cache-read tokens', 10, -1, undefined],
  ['cache-read tokens', 10, 1.5, undefined],
  ['cache-write tokens', 10, undefined, -1],
  ['cache-write tokens', 10, undefined, Number.NaN],
] as const)('inclusive input usage rejects invalid %s', (name, inputTokens, cacheReadTokens, cacheWriteTokens) => {
  expect(() => splitInclusiveInputTokens(inputTokens, cacheReadTokens, cacheWriteTokens)).toThrowError(
    `${name} must be a non-negative safe integer`,
  );
});

test('inclusive input usage rejects cache subsets larger than the total', () => {
  expect(() => splitInclusiveInputTokens(40, 30, 25)).toThrowError('cache token counts exceed inclusive input tokens');
});

test('inclusive output usage splits reasoning into a disjoint count', () => {
  expect(splitInclusiveOutputTokens(5, 2)).toEqual({ output: 3, reasoning: 2 });
  expect(() => splitInclusiveOutputTokens(5, 6)).toThrowError('reasoning tokens exceed inclusive output tokens');
  expect(() => splitInclusiveOutputTokens(5, 1.5)).toThrowError('reasoning tokens must be a non-negative safe integer');
});

test('cache-write usage splits the 1-hour subset from the wire total', () => {
  expect(splitCacheWriteTokens(9, 5)).toEqual({ cacheWrite: 4, cacheWrite1h: 5 });
  expect(splitCacheWriteTokens(undefined, 0)).toEqual({ cacheWrite: 0, cacheWrite1h: 0 });
  expect(() => splitCacheWriteTokens(4, 5)).toThrowError('exceed');
  expect(() => splitCacheWriteTokens(undefined, 1)).toThrowError('require');
});

test('billable usage adds across the turns one response spans', () => {
  const a = { input: 10, cacheRead: 1, cacheWrite: 2, cacheWrite1h: 3, output: 4, tier: 'flex' };
  const b = { input: 1, cacheRead: 1, cacheWrite: 1, cacheWrite1h: 1, output: 1, tier: 'priority' };

  expect(sumBillableUsage(a, b)).toEqual({
    input: 11, cacheRead: 2, cacheWrite: 3, cacheWrite1h: 4, output: 5,
    // A tier cannot be summed; the latest turn's is the one served.
    tier: 'priority',
  });
  expect(sumBillableUsage(undefined, b)).toEqual(b);
  expect(sumBillableUsage(a, undefined)).toEqual(a);
  expect(sumBillableUsage(undefined, undefined)).toBeUndefined();
});
