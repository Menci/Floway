import { test } from 'vitest';

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
