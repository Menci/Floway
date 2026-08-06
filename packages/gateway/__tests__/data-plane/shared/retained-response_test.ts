import { expect, test, vi } from 'vitest';

import {
  retainResponse,
  type RetainedResponseLimits,
} from '../../../src/data-plane/shared/retained-response.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import { assertEquals } from '@floway-dev/test-utils';

const limits = (
  idleTimeoutMs: number,
  totalTimeoutMs: number,
  postDisconnectDrainTimeoutMs: number,
): RetainedResponseLimits => ({
  idleTimeoutMs,
  totalTimeoutMs,
  postDisconnectDrainTimeoutMs,
});

const captureBackgroundTasks = (): {
  readonly tasks: Promise<unknown>[];
  readonly scheduler: BackgroundScheduler;
} => {
  const tasks: Promise<unknown>[] = [];
  return {
    tasks,
    scheduler: task => {
      tasks.push(task);
      void task.catch(() => {});
    },
  };
};

const outcomeOf = async <T>(promise: Promise<T>): Promise<
  { readonly status: 'fulfilled'; readonly value: T }
  | { readonly status: 'rejected'; readonly reason: unknown }
> => await promise.then(
  value => ({ status: 'fulfilled', value } as const),
  reason => ({ status: 'rejected', reason } as const),
);

const expectTimeout = (reason: unknown, kind: 'idle' | 'total' | 'post-disconnect'): void => {
  expect(reason).toMatchObject({
    name: 'RetainedResponseTimeoutError',
    kind,
    message: `Retained upstream response exceeded its ${kind} timeout`,
  });
};

test('retainResponse drains the source without canceling it when its consumer disconnects', async () => {
  let sourceController!: ReadableStreamDefaultController<Uint8Array>;
  let sourceCanceled = false;
  let cancelReason: unknown;
  const background = captureBackgroundTasks();
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      sourceController = controller;
    },
    cancel() {
      sourceCanceled = true;
    },
  });
  const retained = retainResponse(new Response(source), {
    backgroundScheduler: background.scheduler,
    onCancel: reason => { cancelReason = reason; },
  });
  const reader = retained.body!.getReader();

  sourceController.enqueue(new Uint8Array([1]));
  assertEquals(await reader.read(), { done: false, value: new Uint8Array([1]) });
  await reader.cancel('client disconnected');

  assertEquals(cancelReason, 'client disconnected');
  assertEquals(sourceCanceled, false);
  assertEquals(background.tasks.length, 1);

  sourceController.enqueue(new Uint8Array([2]));
  sourceController.close();
  await Promise.all(background.tasks);
  assertEquals(sourceCanceled, false);
});

test('a connected response stalled behind one queued chunk hits the exact idle deadline', async () => {
  vi.useFakeTimers();
  try {
    const initialTimerCount = vi.getTimerCount();
    let sourceController!: ReadableStreamDefaultController<Uint8Array>;
    let sourceCancelReason: unknown;
    let sourceCancelCount = 0;
    const onSettled = vi.fn();
    const background = captureBackgroundTasks();
    const retained = retainResponse(
      new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          sourceController = controller;
        },
        cancel(reason) {
          sourceCancelCount += 1;
          sourceCancelReason = reason;
        },
      })),
      {
        backgroundScheduler: background.scheduler,
        limits: limits(10, 100, 100),
        onSettled,
      },
    );

    // The retained body's default queue accepts this chunk, then applies
    // backpressure because no downstream reader consumes it. Lifecycle timers
    // must remain armed while no reader.read() is active.
    sourceController.enqueue(Uint8Array.of(1));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(9);
    assertEquals(sourceCancelCount, 0);

    await vi.advanceTimersByTimeAsync(1);
    const read = outcomeOf(retained.body!.getReader().read());
    const lifetime = outcomeOf(background.tasks[0]!);
    const readOutcome = await read;
    const lifetimeOutcome = await lifetime;

    expectTimeout(sourceCancelReason, 'idle');
    expect(readOutcome).toEqual({ status: 'rejected', reason: sourceCancelReason });
    expect(lifetimeOutcome).toEqual({ status: 'rejected', reason: sourceCancelReason });
    expect(sourceCancelCount).toBe(1);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(initialTimerCount);
  } finally {
    vi.useRealTimers();
  }
});

test('source chunks reset idle time while the absolute total deadline remains fixed', async () => {
  vi.useFakeTimers();
  try {
    const initialTimerCount = vi.getTimerCount();
    let sourceController!: ReadableStreamDefaultController<Uint8Array>;
    let sourceCancelReason: unknown;
    let sourceCancelCount = 0;
    const onSettled = vi.fn();
    const background = captureBackgroundTasks();
    const retained = retainResponse(
      new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          sourceController = controller;
        },
        cancel(reason) {
          sourceCancelCount += 1;
          sourceCancelReason = reason;
        },
      })),
      {
        backgroundScheduler: background.scheduler,
        limits: limits(10, 25, 100),
        onSettled,
      },
    );
    const reader = retained.body!.getReader();

    const first = reader.read();
    sourceController.enqueue(Uint8Array.of(1));
    expect(await first).toEqual({ done: false, value: Uint8Array.of(1) });

    const second = reader.read();
    await vi.advanceTimersByTimeAsync(9);
    sourceController.enqueue(Uint8Array.of(2));
    expect(await second).toEqual({ done: false, value: Uint8Array.of(2) });

    const third = reader.read();
    await vi.advanceTimersByTimeAsync(9);
    sourceController.enqueue(Uint8Array.of(3));
    expect(await third).toEqual({ done: false, value: Uint8Array.of(3) });

    const terminal = outcomeOf(reader.read());
    await vi.advanceTimersByTimeAsync(6);
    expect(sourceCancelCount).toBe(0);
    await vi.advanceTimersByTimeAsync(1);

    const terminalOutcome = await terminal;
    const lifetimeOutcome = await outcomeOf(background.tasks[0]!);
    expectTimeout(sourceCancelReason, 'total');
    expect(terminalOutcome).toEqual({ status: 'rejected', reason: sourceCancelReason });
    expect(lifetimeOutcome).toEqual({ status: 'rejected', reason: sourceCancelReason });
    expect(sourceCancelCount).toBe(1);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(initialTimerCount);
  } finally {
    vi.useRealTimers();
  }
});

test('retainResponse cancels a stalled source at the post-disconnect deadline', async () => {
  vi.useFakeTimers();
  try {
    const initialTimerCount = vi.getTimerCount();
    let sourceCancelReason: unknown;
    let sourceCancelCount = 0;
    const onSettled = vi.fn();
    const background = captureBackgroundTasks();
    const retained = retainResponse(
      new Response(new ReadableStream<Uint8Array>({
        pull: () => new Promise<void>(() => {}),
        cancel(reason) {
          sourceCancelCount += 1;
          sourceCancelReason = reason;
        },
      }, { highWaterMark: 0 })),
      {
        backgroundScheduler: background.scheduler,
        limits: limits(100, 100, 10),
        onSettled,
      },
    );
    const reader = retained.body!.getReader();
    const pending = reader.read();
    await reader.cancel('client left');

    await vi.advanceTimersByTimeAsync(9);
    expect(sourceCancelCount).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await pending.catch(() => {});

    const lifetimeOutcome = await outcomeOf(background.tasks[0]!);
    expectTimeout(sourceCancelReason, 'post-disconnect');
    expect(lifetimeOutcome).toEqual({ status: 'rejected', reason: sourceCancelReason });
    expect(sourceCancelCount).toBe(1);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(initialTimerCount);
  } finally {
    vi.useRealTimers();
  }
});

test('a client disconnect signal starts the deadline without canceling the downstream body', async () => {
  vi.useFakeTimers();
  try {
    const initialTimerCount = vi.getTimerCount();
    let sourceCancelReason: unknown;
    let sourceCancelCount = 0;
    const controller = new AbortController();
    const onSettled = vi.fn();
    const background = captureBackgroundTasks();
    const retained = retainResponse(
      new Response(new ReadableStream<Uint8Array>({
        pull: () => new Promise<void>(() => {}),
        cancel(reason) {
          sourceCancelCount += 1;
          sourceCancelReason = reason;
        },
      }, { highWaterMark: 0 })),
      {
        backgroundScheduler: background.scheduler,
        clientDisconnectSignal: controller.signal,
        limits: limits(100, 100, 10),
        onSettled,
      },
    );
    const terminal = outcomeOf(retained.body!.getReader().read());

    controller.abort(new Error('client left'));
    await vi.advanceTimersByTimeAsync(9);
    expect(sourceCancelCount).toBe(0);
    await vi.advanceTimersByTimeAsync(1);

    const terminalOutcome = await terminal;
    const lifetimeOutcome = await outcomeOf(background.tasks[0]!);
    expectTimeout(sourceCancelReason, 'post-disconnect');
    expect(terminalOutcome).toEqual({ status: 'rejected', reason: sourceCancelReason });
    expect(lifetimeOutcome).toEqual({ status: 'rejected', reason: sourceCancelReason });
    expect(sourceCancelCount).toBe(1);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(initialTimerCount);
  } finally {
    vi.useRealTimers();
  }
});

test('nested retained bodies share one absolute post-disconnect deadline', async () => {
  vi.useFakeTimers();
  try {
    const initialTimerCount = vi.getTimerCount();
    let sourceCancelReason: unknown;
    let sourceCancelCount = 0;
    const innerSettled = vi.fn();
    const outerSettled = vi.fn();
    const background = captureBackgroundTasks();
    const sharedLimits = limits(100, 100, 10);
    const inner = retainResponse(
      new Response(new ReadableStream<Uint8Array>({
        pull: () => new Promise<void>(() => {}),
        cancel(reason) {
          sourceCancelCount += 1;
          sourceCancelReason = reason;
        },
      }, { highWaterMark: 0 })),
      {
        backgroundScheduler: background.scheduler,
        limits: sharedLimits,
        onSettled: innerSettled,
      },
    );
    const outer = retainResponse(inner, {
      backgroundScheduler: background.scheduler,
      limits: sharedLimits,
      onSettled: outerSettled,
    });
    const reader = outer.body!.getReader();
    const pending = reader.read();
    await reader.cancel('client left');

    await vi.advanceTimersByTimeAsync(9);
    expect(sourceCancelCount).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await pending.catch(() => {});
    const outcomes = await Promise.all(background.tasks.map(outcomeOf));

    expectTimeout(sourceCancelReason, 'post-disconnect');
    expect(sourceCancelCount).toBe(1);
    expect(outcomes).toEqual([
      { status: 'rejected', reason: sourceCancelReason },
      { status: 'rejected', reason: sourceCancelReason },
    ]);
    expect(innerSettled).toHaveBeenCalledTimes(1);
    expect(outerSettled).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(initialTimerCount);
  } finally {
    vi.useRealTimers();
  }
});

test('retained response limits reject every invalid timer field and accept timer boundaries', () => {
  const backgroundScheduler: BackgroundScheduler = () => {};
  const valid = limits(1, 1, 1);
  const fields = Object.keys(valid) as Array<keyof RetainedResponseLimits>;
  const invalidValues = [0, 1.5, 0x8000_0000];

  for (const field of fields) {
    for (const value of invalidValues) {
      expect(() => retainResponse(new Response(null), {
        backgroundScheduler,
        limits: { ...valid, [field]: value },
      })).toThrowError(new RangeError(`Retained response ${field} must be a positive 32-bit timer value`));
    }

    const missing = { ...valid } as Partial<RetainedResponseLimits>;
    delete missing[field];
    expect(() => retainResponse(new Response(null), {
      backgroundScheduler,
      limits: missing as RetainedResponseLimits,
    })).toThrowError(new RangeError(`Retained response ${field} must be a positive 32-bit timer value`));
  }

  expect(() => retainResponse(new Response(null), {
    backgroundScheduler,
    limits: limits(1, 1, 1),
  })).not.toThrow();
  expect(() => retainResponse(new Response(null), {
    backgroundScheduler,
    limits: limits(0x7FFF_FFFF, 0x7FFF_FFFF, 0x7FFF_FFFF),
  })).not.toThrow();
});

test('an undefined source rejection remains a rejected lifetime', async () => {
  const onSettled = vi.fn();
  const background = captureBackgroundTasks();
  const retained = retainResponse(
    new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(undefined);
      },
    })),
    {
      backgroundScheduler: background.scheduler,
      onSettled,
    },
  );

  expect(await outcomeOf(retained.body!.getReader().read())).toEqual({
    status: 'rejected',
    reason: undefined,
  });
  expect(await outcomeOf(background.tasks[0]!)).toEqual({
    status: 'rejected',
    reason: undefined,
  });
  expect(onSettled).toHaveBeenCalledTimes(1);
});

test('source cancellation rejection reaches its explicit error sink without extending the deadline', async () => {
  vi.useFakeTimers();
  try {
    const cancelError = new Error('cancel cleanup failed');
    const onSourceCancelError = vi.fn();
    const background = captureBackgroundTasks();
    const retained = retainResponse(
      new Response(new ReadableStream<Uint8Array>({
        pull: () => new Promise<void>(() => {}),
        cancel: () => Promise.reject(cancelError),
      }, { highWaterMark: 0 })),
      {
        backgroundScheduler: background.scheduler,
        limits: limits(10, 100, 100),
        onSourceCancelError,
      },
    );
    const read = outcomeOf(retained.body!.getReader().read());

    await vi.advanceTimersByTimeAsync(10);

    const readOutcome = await read;
    const lifetimeOutcome = await outcomeOf(background.tasks[0]!);
    expectTimeout(readOutcome.status === 'rejected' ? readOutcome.reason : undefined, 'idle');
    expect(lifetimeOutcome).toEqual(readOutcome);
    expect(onSourceCancelError).toHaveBeenCalledTimes(1);
    expect(onSourceCancelError).toHaveBeenCalledWith(cancelError);
  } finally {
    vi.useRealTimers();
  }
});
