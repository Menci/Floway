import { expect, test } from 'vitest';

import { billableServiceTier, splitCacheWriteTokens, splitInclusiveInputTokens, splitInclusiveOutputTokens } from './usage.ts';

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
  expect(splitCacheWriteTokens(9, { cacheWrite1hTokenCount: 5 })).toEqual({ cacheWrite: 4, cacheWrite1h: 5 });
  expect(splitCacheWriteTokens(undefined, undefined)).toEqual({ cacheWrite: 0, cacheWrite1h: 0 });
  expect(() => splitCacheWriteTokens(4, { cacheWrite1hTokenCount: 5 })).toThrowError('exceed');
  expect(() => splitCacheWriteTokens(undefined, { cacheWrite1hTokenCount: 1 })).toThrowError('require');
});
