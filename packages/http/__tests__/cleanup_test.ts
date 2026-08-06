import { afterEach, describe, expect, it, vi } from 'vitest';

import { CLEANUP_OPERATION_DEADLINE_MS, CleanupTimeoutError, cleanupFailure, collectCleanupFailures, failureWithCleanup } from '../src/cleanup.ts';

afterEach(() => vi.useRealTimers());

describe('cleanup failure composition', () => {
  it('runs every operation and keeps cleanup failures in operation order', async () => {
    const first = new Error('first cleanup');
    const second = new Error('second cleanup');
    const calls: number[] = [];
    const failures = await collectCleanupFailures([
      () => { calls.push(1); throw first; },
      () => { calls.push(2); },
      async () => { calls.push(3); throw second; },
    ]);

    expect(calls).toEqual([1, 2, 3]);
    expect(failures).toEqual([first, second]);
    const combined = cleanupFailure(failures, 'cleanup failed') as AggregateError;
    expect(combined).toBeInstanceOf(AggregateError);
    expect(combined.errors).toEqual([first, second]);
    expect(combined.cause).toBe(first);
  });

  it('preserves a single cleanup error and puts a primary first in an aggregate', () => {
    const primary = new Error('primary');
    const cleanup = new Error('cleanup');

    expect(cleanupFailure([cleanup], 'cleanup failed')).toBe(cleanup);
    const combined = failureWithCleanup(primary, [cleanup], 'both failed') as AggregateError;
    expect(combined.errors).toEqual([primary, cleanup]);
    expect(combined.cause).toBe(primary);
  });

  it('retains undefined as a real cleanup failure value', async () => {
    const failures = await collectCleanupFailures([() => { throw undefined; }]);

    expect(failures).toEqual([undefined]);
    expect(cleanupFailure(failures, 'cleanup failed')).toBeUndefined();
  });

  it('bounds a never-settling operation, continues cleanup, and observes late rejection', async () => {
    vi.useFakeTimers();
    let rejectLate!: (reason?: unknown) => void;
    const never = new Promise<void>((_resolve, reject) => { rejectLate = reject; });
    const afterTimeout = vi.fn();
    const settlement = collectCleanupFailures([
      async () => await never,
      afterTimeout,
    ]);

    await vi.advanceTimersByTimeAsync(CLEANUP_OPERATION_DEADLINE_MS);
    const failures = await settlement;
    expect(failures).toHaveLength(1);
    expect(failures[0]).toBeInstanceOf(CleanupTimeoutError);
    expect(afterTimeout).toHaveBeenCalledOnce();

    rejectLate(undefined);
    await Promise.resolve();
  });
});
