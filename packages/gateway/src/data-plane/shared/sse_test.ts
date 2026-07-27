import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { test } from 'vitest';

import { writeSSEFrames } from './sse.ts';
import { FakeTime } from '../../test-time.ts';
import { parseSSEStream } from '@floway-dev/protocols/common';
import { sseCommentFrame, type SseFrame, sseFrame } from '@floway-dev/protocols/common';
import { assertEquals } from '@floway-dev/test-utils';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
};

const closedIteratorResult = (): IteratorResult<SseFrame> => ({
  done: true,
  value: undefined,
});

const createIdleSSEEvents = () => {
  let pendingNext: Deferred<IteratorResult<SseFrame>> | undefined;
  let returnCalled = false;

  const events: AsyncIterable<SseFrame> = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          pendingNext = deferred<IteratorResult<SseFrame>>();
          return pendingNext.promise;
        },
        return() {
          returnCalled = true;
          pendingNext?.resolve(closedIteratorResult());
          return Promise.resolve(closedIteratorResult());
        },
      };
    },
  };

  return {
    events,
    hasPendingNext: () => pendingNext !== undefined,
    rejectNext: (error: unknown) => pendingNext?.reject(error),
    returnCalled: () => returnCalled,
  };
};

const waitForIteratorStart = async (events: ReturnType<typeof createIdleSSEEvents>) => {
  for (let i = 0; i < 10; i++) {
    if (events.hasPendingNext()) return;
    await Promise.resolve();
  }

  throw new Error('SSE iterator did not start');
};

const waitForIteratorReturn = async (events: ReturnType<typeof createIdleSSEEvents>) => {
  for (let i = 0; i < 10; i++) {
    if (events.returnCalled()) return;
    await Promise.resolve();
  }

  throw new Error('SSE iterator was not stopped');
};

const requestSSE = async (events: AsyncIterable<SseFrame>, options: NonNullable<Parameters<typeof writeSSEFrames>[2]>): Promise<Response> => {
  const app = new Hono();
  app.get('/', c =>
    streamSSE(c, async stream => {
      await writeSSEFrames(stream, events, options);
    }));
  return await app.request('/');
};

const decodeChunk = (value: Uint8Array | undefined): string => new TextDecoder().decode(value);

const waitForMicrotasks = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

const cancelStateWithin = async (promise: Promise<void>, timeoutMs: number): Promise<'canceled' | 'pending'> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => 'canceled' as const),
      new Promise<'pending'>(resolve => {
        timeoutId = setTimeout(() => resolve('pending'), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
};

test('writeSSEFrames emits SSE comment keepalive frames while idle', async () => {
  const time = new FakeTime();
  const idle = createIdleSSEEvents();

  try {
    const response = await requestSSE(idle.events, {
      keepAlive: { intervalMs: 1_000, frame: sseCommentFrame('keepalive') },
    });
    const reader = response.body!.getReader();

    await waitForIteratorStart(idle);
    const read = reader.read();
    await time.tickAsync(1_000);

    const chunk = await read;
    assertEquals(decodeChunk(chunk.value), ': keepalive\n\n');

    await reader.cancel();
  } finally {
    time.restore();
  }
});

test('writeSSEFrames emits Messages ping keepalive frames while idle', async () => {
  const time = new FakeTime();
  const idle = createIdleSSEEvents();

  try {
    const response = await requestSSE(idle.events, {
      keepAlive: {
        intervalMs: 1_000,
        frame: sseFrame(JSON.stringify({ type: 'ping' }), 'ping'),
      },
    });
    const reader = response.body!.getReader();

    await waitForIteratorStart(idle);
    const read = reader.read();
    await time.tickAsync(1_000);

    const chunk = await read;
    assertEquals(decodeChunk(chunk.value), 'event: ping\ndata: {"type":"ping"}\n\n');

    await reader.cancel();
  } finally {
    time.restore();
  }
});

test('writeSSEFrames does not emit keepalive before ready events', async () => {
  const response = await requestSSE(
    (async function* () {
      yield sseFrame('{}', 'response.completed');
    })(),
    { keepAlive: { intervalMs: 1_000, frame: sseCommentFrame('keepalive') } },
  );

  assertEquals(await response.text(), 'event: response.completed\ndata: {}\n\n');
});

test('writeSSEFrames stops idle iterator and timer when the response is canceled', async () => {
  const time = new FakeTime();
  const idle = createIdleSSEEvents();

  try {
    const response = await requestSSE(idle.events, {
      keepAlive: { intervalMs: 1_000, frame: sseCommentFrame('keepalive') },
    });
    const reader = response.body!.getReader();

    await waitForIteratorStart(idle);
    await reader.cancel();
    await waitForIteratorReturn(idle);

    assertEquals(idle.returnCalled(), true);
    await time.tickAsync(5_000);
  } finally {
    time.restore();
  }
});

test('writeSSEFrames handles pending iterator errors after the response is canceled', async () => {
  const idle = createIdleSSEEvents();
  const response = await requestSSE(idle.events, {
    keepAlive: { intervalMs: 1_000, frame: sseCommentFrame('keepalive') },
  });
  const reader = response.body!.getReader();

  await waitForIteratorStart(idle);
  await reader.cancel();
  idle.rejectNext(new Error('late upstream stream failure'));
  await waitForIteratorReturn(idle);

  assertEquals(idle.returnCalled(), true);
});

test('writeSSEFrames aborts a pending upstream SSE reader when the downstream response is canceled', async () => {
  const upstreamCanceled = deferred<void>();
  let upstreamController!: ReadableStreamDefaultController<Uint8Array>;
  const downstreamAbortController = new AbortController();
  const upstreamBody = new ReadableStream<Uint8Array>({
    start(controller) {
      upstreamController = controller;
    },
    cancel() {
      upstreamCanceled.resolve();
    },
  });
  const response = await requestSSE(
    parseSSEStream(upstreamBody, {
      signal: downstreamAbortController.signal,
    }),
    {
      keepAlive: { intervalMs: 1_000, frame: sseCommentFrame('keepalive') },
      downstreamAbortController,
    },
  );
  const reader = response.body!.getReader();
  const pendingRead = reader.read();
  let cancelResponse: Promise<void> | undefined;

  try {
    await waitForMicrotasks();
    cancelResponse = reader.cancel();

    const cancelState = await cancelStateWithin(upstreamCanceled.promise, 20);

    assertEquals(cancelState, 'canceled');
  } finally {
    try {
      upstreamController.close();
    } catch {
      // The stream is already canceled in the passing path.
    }
    await pendingRead.catch(() => {});
    await cancelResponse?.catch(() => {});
  }
});
