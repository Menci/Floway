import { describe, test, vi } from 'vitest';

import { attemptTtftMs, stampUpstreamCallStart, type AttemptTiming } from '../../../src/data-plane/shared/attempt-timing.ts';
import { assert, assertEquals, assertExists } from '@floway-dev/test-utils';

describe('stampUpstreamCallStart', () => {
  const freshTiming = (): AttemptTiming => ({
    upstreamCallStartedAt: null,
    firstOutputTokenAt: null,
  });

  test('stamps upstreamCallStartedAt synchronously before the dispatch runs', async () => {
    const timing = freshTiming();
    let stampedAtDispatchEntry: number | null = null;
    const dispatch = () => {
      // Sampled inside the dispatch: the factory must have stamped the slot
      // before handing control off, so this read must see a real number.
      stampedAtDispatchEntry = timing.upstreamCallStartedAt;
      return Promise.resolve('done');
    };
    const before = performance.now();
    await stampUpstreamCallStart(timing)(dispatch);
    const after = performance.now();

    assertExists(stampedAtDispatchEntry);
    assert(stampedAtDispatchEntry >= before && stampedAtDispatchEntry <= after,
      `stamp ${stampedAtDispatchEntry} outside [${before}, ${after}]`);
  });

  test('tool continuations preserve the completed first-token measurement', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValueOnce(100).mockReturnValueOnce(200);
    try {
      const timing = freshTiming();
      const dispatch = stampUpstreamCallStart(timing);
      await dispatch(() => Promise.resolve());
      timing.firstOutputTokenAt = 150;
      assertEquals(attemptTtftMs(timing), 50);

      let continuationStartedAt: number | null = null;
      await dispatch(() => {
        continuationStartedAt = timing.upstreamCallStartedAt;
        return Promise.resolve();
      });

      assertEquals(continuationStartedAt, 100);
      assertEquals(attemptTtftMs(timing), 50);
      assertEquals(clock.mock.calls.length, 1);
    } finally {
      clock.mockRestore();
    }
  });
});
