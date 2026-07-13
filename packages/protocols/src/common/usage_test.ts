import { expect, test } from 'vitest';

import { splitInclusiveInputTokens } from './usage.ts';

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
