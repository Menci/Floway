import { expect, test } from 'vitest';

import { attemptTtftMs } from '../../../src/data-plane/shared/attempt-timing.ts';

test('TTFT uses the dispatch timestamp, includes a zero timestamp, and rounds to milliseconds', () => {
  expect(attemptTtftMs({ upstreamCallStartedAt: 0, firstOutputTokenAt: 120.6 })).toBe(121);
  expect(attemptTtftMs({ upstreamCallStartedAt: 19.7, firstOutputTokenAt: 20.1 })).toBe(0);
});

test('TTFT is absent until dispatch and first output are both observed', () => {
  expect(attemptTtftMs(undefined)).toBeNull();
  expect(attemptTtftMs({ upstreamCallStartedAt: null, firstOutputTokenAt: 10 })).toBeNull();
  expect(attemptTtftMs({ upstreamCallStartedAt: 0, firstOutputTokenAt: null })).toBeNull();
});
