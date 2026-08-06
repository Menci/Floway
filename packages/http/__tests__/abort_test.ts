import { afterEach, describe, expect, it, vi } from 'vitest';

import { collectPromptCleanupFailures, startPromptCleanup } from '../src/abort.ts';

describe('prompt abort cleanup observation', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    ['immediate Error', new Error('immediate cleanup'), (failure: unknown) => { throw failure; }],
    ['immediate undefined', undefined, (failure: unknown) => { throw failure; }],
    ['microtask rejection', new Error('microtask cleanup'), (failure: unknown) => Promise.reject(failure)],
    ['next-task rejection', new Error('next-task cleanup'), (failure: unknown) => new Promise<void>((_resolve, reject) => {
      setTimeout(() => reject(failure), 0);
    })],
  ])('attaches %s before prompt settlement', async (_label, failure, operation) => {
    vi.useFakeTimers();
    const primary = new Error('abort');
    const cleanup = startPromptCleanup('test cleanup', () => operation(failure));
    const pending = collectPromptCleanupFailures([cleanup], primary);

    await vi.advanceTimersByTimeAsync(0);

    expect(await pending).toEqual([failure]);
  });

  it('reports a late rejection at the stable sink without changing prompt settlement', async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const late = new Error('late cleanup');
    const cleanup = startPromptCleanup('late test cleanup', () => new Promise<void>((_resolve, reject) => {
      setTimeout(() => reject(late), 10);
    }));
    const pending = collectPromptCleanupFailures([cleanup], new Error('abort'));

    await vi.advanceTimersByTimeAsync(0);
    expect(await pending).toEqual([]);
    await vi.advanceTimersByTimeAsync(10);
    expect(log).toHaveBeenCalledWith(
      '[abort-cleanup] late test cleanup failed after prompt abort settlement:',
      late,
    );
  });

  it('reports never-settling cleanup after the detached deadline without delaying abort', async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cleanup = startPromptCleanup('stalled test cleanup', () => new Promise<void>(() => {}));
    const pending = collectPromptCleanupFailures([cleanup], new Error('abort'));

    await vi.advanceTimersByTimeAsync(0);
    expect(await pending).toEqual([]);
    expect(log).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(log).toHaveBeenCalledWith(
      '[abort-cleanup] stalled test cleanup did not settle after prompt abort:',
      expect.objectContaining({ name: 'CleanupTimeoutError', timeoutMs: 5_000 }),
    );
  });
});
