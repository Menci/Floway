import { test } from 'vitest';

import { dispatchWebSearchFetch, fetchWithRetry } from '../../../../../src/data-plane/tools/web-search/providers/shared.ts';
import { FakeTime } from '../../../../test-time.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('web-search retry checks client disconnect before each dispatch', async () => {
  const time = new FakeTime();
  const controller = new AbortController();
  const backgroundTasks: Promise<unknown>[] = [];
  let dispatches = 0;
  const lifecycle = {
    clientDisconnectSignal: controller.signal,
    backgroundScheduler: (task: Promise<unknown>) => { backgroundTasks.push(task); },
  };

  try {
    let caught: unknown;
    const result = fetchWithRetry(
      async () => await dispatchWebSearchFetch(async () => {
        dispatches += 1;
        return new Response('retry', { status: 429 });
      }, lifecycle),
    ).catch(error => { caught = error; });
    await Promise.resolve();
    controller.abort(new Error('client disconnected'));
    await time.tickAsync(1_000);

    await result;
    assertEquals(caught, controller.signal.reason);
    assertEquals(dispatches, 1);
    await Promise.all(backgroundTasks);
  } finally {
    time.restore();
  }
});
