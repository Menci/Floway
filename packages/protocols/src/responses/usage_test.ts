import { expect, test } from 'vitest';

import { splitResponsesInputTokens } from './usage.ts';

test('Responses input usage splits inclusive cache reads and writes into disjoint counts', () => {
  expect(splitResponsesInputTokens(100, 30, 25)).toEqual({ input: 45, cacheRead: 30, cacheWrite: 25 });
});

test.each([
  ['input_tokens', -1, undefined, undefined],
  ['input_tokens', Number.POSITIVE_INFINITY, undefined, undefined],
  ['cached_tokens', 10, -1, undefined],
  ['cached_tokens', 10, 1.5, undefined],
  ['cache_write_tokens', 10, undefined, -1],
  ['cache_write_tokens', 10, undefined, Number.NaN],
] as const)('Responses input usage rejects invalid %s', (name, inputTokens, cachedTokens, cacheWriteTokens) => {
  expect(() => splitResponsesInputTokens(inputTokens, cachedTokens, cacheWriteTokens)).toThrowError(
    `Responses ${name} must be a non-negative safe integer`,
  );
});
