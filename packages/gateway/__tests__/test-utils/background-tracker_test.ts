import { expect, test } from 'vitest';

import { flushBackground, flushBackgroundExpectingFailures, trackBackground } from './background-tracker.ts';

test('flushBackground propagates an unexpected task failure by identity', async () => {
  const failure = new Error('background failed');
  trackBackground(Promise.reject(failure));

  await expect(flushBackground()).rejects.toBe(failure);
});

test('flushBackgroundExpectingFailures requires the exact failure identities and count', async () => {
  const first = new Error('first background failure');
  const second = new Error('second background failure');
  trackBackground(Promise.reject(first));
  trackBackground(Promise.reject(second));

  await flushBackgroundExpectingFailures(first, second);
});
