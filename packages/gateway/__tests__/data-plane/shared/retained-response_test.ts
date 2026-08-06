import { test, vi } from 'vitest';

import { retainResponse } from '../../../src/data-plane/shared/retained-response.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('retainResponse drains the source without canceling it when its consumer disconnects', async () => {
  let sourceController!: ReadableStreamDefaultController<Uint8Array>;
  let sourceCanceled = false;
  let cancelReason: unknown;
  const backgroundTasks: Promise<unknown>[] = [];
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      sourceController = controller;
    },
    cancel() {
      sourceCanceled = true;
    },
  });
  const retained = retainResponse(
    new Response(source),
    task => { backgroundTasks.push(task); },
    reason => { cancelReason = reason; },
  );
  const reader = retained.body!.getReader();

  sourceController.enqueue(new Uint8Array([1]));
  assertEquals(await reader.read(), { done: false, value: new Uint8Array([1]) });
  await reader.cancel('client disconnected');

  assertEquals(cancelReason, 'client disconnected');
  assertEquals(sourceCanceled, false);
  assertEquals(backgroundTasks.length, 1);

  sourceController.enqueue(new Uint8Array([2]));
  sourceController.close();
  await Promise.all(backgroundTasks);
  assertEquals(sourceCanceled, false);
});

test('retainResponse cancels a stalled source at the post-disconnect deadline', async () => {
  vi.useFakeTimers();
  try {
    let sourceCanceled = false;
    const backgroundTasks: Promise<unknown>[] = [];
    const retained = retainResponse(
      new Response(new ReadableStream<Uint8Array>({
        pull: () => new Promise<void>(() => {}),
        cancel() {
          sourceCanceled = true;
        },
      }, { highWaterMark: 0 })),
      task => { backgroundTasks.push(task); },
      undefined,
      { idleTimeoutMs: 1_000, totalTimeoutMs: 1_000, postDisconnectDrainTimeoutMs: 10 },
    );
    const reader = retained.body!.getReader();
    const pending = reader.read();
    await reader.cancel('client left');

    await vi.advanceTimersByTimeAsync(10);
    await Promise.all(backgroundTasks);
    await pending.catch(() => {});
    assertEquals(sourceCanceled, true);
  } finally {
    vi.useRealTimers();
  }
});
