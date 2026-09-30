import { describe, test } from 'vitest';

import { stampUpstreamCallStart, type AttemptTiming } from '../../../src/data-plane/shared/attempt-timing.ts';
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

  test('resolves to the dispatched value', async () => {
    const timing = freshTiming();
    const result = await stampUpstreamCallStart(timing)(() => Promise.resolve({ payload: 42 }));
    assertEquals(result, { payload: 42 });
  });

  test('propagates a rejection from the dispatch verbatim', async () => {
    const timing = freshTiming();
    const err = new Error('boom');
    let caught: unknown;
    await stampUpstreamCallStart(timing)(() => Promise.reject(err)).catch(e => { caught = e; });
    assertEquals(caught, err);
    // Even a rejected dispatch reflects a real upstream-call start.
    assertExists(timing.upstreamCallStartedAt);
  });

  test('stamps exactly once per invocation of the returned factory', async () => {
    const timing = freshTiming();
    const factory = stampUpstreamCallStart(timing);
    let midDispatchReading: number | null = null;
    await factory(() => {
      midDispatchReading = timing.upstreamCallStartedAt;
      return Promise.resolve();
    });
    // The slot is stamped once at factory entry; the dispatch body must
    // observe the same value, and the post-resolve value must match — no
    // hidden re-stamp on completion.
    assertEquals(timing.upstreamCallStartedAt, midDispatchReading);
  });

  test('re-stamps on each invocation of the returned factory', async () => {
    const timing = freshTiming();
    const factory = stampUpstreamCallStart(timing);

    await factory(() => Promise.resolve());
    const first = timing.upstreamCallStartedAt;
    assertExists(first);

    // Force a monotonic gap so the second stamp is provably distinct.
    await new Promise(resolve => setTimeout(resolve, 1));

    await factory(() => Promise.resolve());
    const second = timing.upstreamCallStartedAt;
    assertExists(second);
    assert(second > first, `expected second stamp ${second} to exceed first ${first}`);
  });
});
