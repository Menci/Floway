import { test } from 'vitest';

import { retainResponse } from '../../../src/data-plane/shared/retained-response.ts';
import { FakeTime } from '../../test-time.ts';
import { assertEquals, assertStringIncludes } from '@floway-dev/test-utils';

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

// The drain is the only reader left once the client is gone, so an upstream
// that stalls without ending the stream would pin its transport forever.
test('retainResponse abandons a drain whose upstream stops producing', async () => {
  const time = new FakeTime();
  try {
    let sourceCanceled = false;
    let cancelReason: unknown;
    const backgroundTasks: Promise<unknown>[] = [];
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      // Never produces again and never closes, which is what a hung upstream
      // looks like from here.
      pull() { return new Promise<never>(() => {}); },
      cancel(reason) {
        sourceCanceled = true;
        cancelReason = reason;
      },
    });
    const retained = retainResponse(new Response(source), task => { backgroundTasks.push(task); });
    const reader = retained.body!.getReader();
    assertEquals(await reader.read(), { done: false, value: new Uint8Array([1]) });
    await reader.cancel('client disconnected');

    // Well inside the budget the upstream is still held, so usage and dump
    // records for a slow generation still settle.
    await time.tickAsync(14 * 60 * 1000);
    assertEquals(sourceCanceled, false);

    await time.tickAsync(60 * 1000 + 1);
    assertEquals(sourceCanceled, true);
    assertEquals(cancelReason instanceof Error, true);
    assertStringIncludes((cancelReason as Error).message, 'after the client disconnected');
    await Promise.all(backgroundTasks.map(task => task.catch(() => undefined)));
  } finally {
    time.restore();
  }
});

test('retainResponse leaves the upstream alone when the drain finishes inside the budget', async () => {
  const time = new FakeTime();
  try {
    let sourceController!: ReadableStreamDefaultController<Uint8Array>;
    let sourceCanceled = false;
    const backgroundTasks: Promise<unknown>[] = [];
    const source = new ReadableStream<Uint8Array>({
      start(controller) { sourceController = controller; },
      cancel() { sourceCanceled = true; },
    });
    const retained = retainResponse(new Response(source), task => { backgroundTasks.push(task); });
    const reader = retained.body!.getReader();
    sourceController.enqueue(new Uint8Array([1]));
    assertEquals(await reader.read(), { done: false, value: new Uint8Array([1]) });
    await reader.cancel('client disconnected');

    sourceController.close();
    await Promise.all(backgroundTasks);

    // The abandon timer must not outlive the drain it was guarding.
    await time.tickAsync(20 * 60 * 1000);
    assertEquals(sourceCanceled, false);
  } finally {
    time.restore();
  }
});
