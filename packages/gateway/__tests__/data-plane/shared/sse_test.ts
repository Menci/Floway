import { Hono } from 'hono';
import { streamSSE, type SSEStreamingApi } from 'hono/streaming';
import { expect, test } from 'vitest';

import { writeSSEFrames } from '../../../src/data-plane/shared/sse.ts';
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
    emit: (frame: SseFrame) => {
      const pending = pendingNext;
      pendingNext = undefined;
      pending?.resolve({ done: false, value: frame });
    },
    close: () => {
      const pending = pendingNext;
      pendingNext = undefined;
      pending?.resolve(closedIteratorResult());
    },
    rejectNext: (error: unknown) => {
      const pending = pendingNext;
      pendingNext = undefined;
      pending?.reject(error);
    },
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

const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

const requestSSE = async (
  events: AsyncIterable<SseFrame>,
  options: NonNullable<Parameters<typeof writeSSEFrames>[2]>,
  completion?: Deferred<Awaited<ReturnType<typeof writeSSEFrames>>>,
): Promise<Response> => {
  const app = new Hono();
  app.get('/', c =>
    streamSSE(c, async stream => {
      try {
        const result = await writeSSEFrames(stream, events, options);
        completion?.resolve(result);
      } catch (error) {
        completion?.reject(error);
      }
    }));
  return await app.request('/');
};

const decodeChunk = (value: Uint8Array | undefined): string => new TextDecoder().decode(value);

const fakeSSEStream = (writeSSE: SSEStreamingApi['writeSSE'] = async () => undefined): SSEStreamingApi => ({
  aborted: false,
  closed: false,
  onAbort: () => {},
  write: async () => undefined,
  writeSSE,
} as unknown as SSEStreamingApi);

test('writeSSEFrames emits SSE comment keepalive frames while idle', async () => {
  const time = new FakeTime();
  const idle = createIdleSSEEvents();
  const completion = deferred<Awaited<ReturnType<typeof writeSSEFrames>>>();

  try {
    const response = await requestSSE(idle.events, {
      keepAlive: { intervalMs: 1_000, frame: sseCommentFrame('keepalive') },
    }, completion);
    const reader = response.body!.getReader();

    await waitForIteratorStart(idle);
    const read = reader.read();
    await time.tickAsync(1_000);

    const chunk = await read;
    assertEquals(decodeChunk(chunk.value), ': keepalive\n\n');

    await reader.cancel();
    await flushMicrotasks();
    idle.close();
    assertEquals(await completion.promise, 'cancel');
  } finally {
    time.restore();
  }
});

test('writeSSEFrames emits Messages ping keepalive frames while idle', async () => {
  const time = new FakeTime();
  const idle = createIdleSSEEvents();
  const completion = deferred<Awaited<ReturnType<typeof writeSSEFrames>>>();

  try {
    const response = await requestSSE(idle.events, {
      keepAlive: {
        intervalMs: 1_000,
        frame: sseFrame(JSON.stringify({ type: 'ping' }), 'ping'),
      },
    }, completion);
    const reader = response.body!.getReader();

    await waitForIteratorStart(idle);
    const read = reader.read();
    await time.tickAsync(1_000);

    const chunk = await read;
    assertEquals(decodeChunk(chunk.value), 'event: ping\ndata: {"type":"ping"}\n\n');

    await reader.cancel();
    await flushMicrotasks();
    idle.close();
    assertEquals(await completion.promise, 'cancel');
  } finally {
    time.restore();
  }
});

test('writeSSEFrames enters discard mode when a keepalive write observes disconnect', async () => {
  const time = new FakeTime();
  const idle = createIdleSSEEvents();
  let aborted = false;
  const stream = {
    get aborted() { return aborted; },
    closed: false,
    onAbort() {},
    writeSSE() {
      aborted = true;
      return Promise.reject(new Error('client disconnected during keepalive'));
    },
  } as unknown as SSEStreamingApi;

  try {
    const completion = writeSSEFrames(stream, idle.events, {
      keepAlive: { intervalMs: 1_000, frame: sseFrame('{}', 'ping') },
    });
    await waitForIteratorStart(idle);
    await time.tickAsync(1_000);
    idle.emit(sseFrame('{"usage":1}'));
    await waitForIteratorStart(idle);
    idle.close();

    assertEquals(await completion, 'cancel');
    assertEquals(idle.returnCalled(), false);
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

test('writeSSEFrames stops writing but drains the iterator when the response is canceled', async () => {
  const time = new FakeTime();
  const idle = createIdleSSEEvents();
  const completion = deferred<Awaited<ReturnType<typeof writeSSEFrames>>>();

  try {
    const response = await requestSSE(idle.events, {
      keepAlive: { intervalMs: 1_000, frame: sseCommentFrame('keepalive') },
    }, completion);
    const reader = response.body!.getReader();

    await waitForIteratorStart(idle);
    await reader.cancel();
    await flushMicrotasks();

    assertEquals(idle.returnCalled(), false);
    await time.tickAsync(5_000);
    idle.emit(sseFrame('{"usage":1}'));
    await waitForIteratorStart(idle);
    idle.close();
    assertEquals(await completion.promise, 'cancel');
    assertEquals(idle.returnCalled(), false);
  } finally {
    time.restore();
  }
});

test('writeSSEFrames preserves a late iterator error after the response is canceled', async () => {
  const idle = createIdleSSEEvents();
  const completion = deferred<Awaited<ReturnType<typeof writeSSEFrames>>>();
  const response = await requestSSE(idle.events, {
    keepAlive: { intervalMs: 1_000, frame: sseCommentFrame('keepalive') },
  }, completion);
  const reader = response.body!.getReader();

  await waitForIteratorStart(idle);
  const cancelResponse = reader.cancel();
  await flushMicrotasks();
  const lateError = new Error('late upstream stream failure');
  idle.rejectNext(lateError);

  await expect(completion.promise).rejects.toBe(lateError);
  await cancelResponse;
  assertEquals(idle.returnCalled(), true);
});

test('writeSSEFrames does not cancel an upstream SSE reader when the downstream response is canceled', async () => {
  let upstreamCanceled = false;
  const upstreamReadStarted = deferred<void>();
  let upstreamController!: ReadableStreamDefaultController<Uint8Array>;
  const clientDisconnectController = new AbortController();
  const completion = deferred<Awaited<ReturnType<typeof writeSSEFrames>>>();
  const upstreamBody = new ReadableStream<Uint8Array>({
    start(controller) {
      upstreamController = controller;
    },
    pull() {
      upstreamReadStarted.resolve();
    },
    cancel() {
      upstreamCanceled = true;
    },
  }, { highWaterMark: 0 });
  const response = await requestSSE(
    parseSSEStream(upstreamBody),
    {
      keepAlive: { intervalMs: 1_000, frame: sseCommentFrame('keepalive') },
      clientDisconnectController,
    },
    completion,
  );
  const reader = response.body!.getReader();
  const pendingRead = reader.read();
  let cancelResponse: Promise<void> | undefined;

  try {
    await upstreamReadStarted.promise;
    cancelResponse = reader.cancel();
    await flushMicrotasks();

    assertEquals(upstreamCanceled, false);
    assertEquals(clientDisconnectController.signal.aborted, true);
    upstreamController.enqueue(new TextEncoder().encode('data: {"usage":1}\n\n'));
    upstreamController.close();
    assertEquals(await completion.promise, 'cancel');
  } finally {
    try {
      upstreamController.close();
    } catch {
      // The stream was already closed by the test.
    }
    await pendingRead.catch(() => {});
    await cancelResponse?.catch(() => {});
  }
});

for (const failurePoint of ['next', 'write'] as const) {
  test(`writeSSEFrames preserves a ${failurePoint} failure when iterator cleanup also fails`, async () => {
    const primaryError = new Error(`${failurePoint} failed`);
    const cleanupError = new Error('iterator cleanup failed');
    const clientDisconnectController = new AbortController();
    let returnCalls = 0;
    let nextCalls = 0;
    const events: AsyncIterable<SseFrame> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            nextCalls += 1;
            if (failurePoint === 'next') throw primaryError;
            return nextCalls === 1
              ? { done: false, value: sseFrame('{}') }
              : closedIteratorResult();
          },
          async return() {
            returnCalls += 1;
            throw cleanupError;
          },
        };
      },
    };
    const stream = fakeSSEStream(async () => {
      if (failurePoint === 'write') throw primaryError;
    });

    const error = await writeSSEFrames(stream, events, { clientDisconnectController }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).message).toBe(primaryError.message);
    expect((error as AggregateError).cause).toBe(primaryError);
    expect((error as AggregateError).errors).toEqual([primaryError, cleanupError]);
    expect(clientDisconnectController.signal.aborted).toBe(false);
    expect(returnCalls).toBe(1);
  });
}

test('writeSSEFrames does not pull another frame while the current write is backpressured', async () => {
  const writeStarted = deferred<void>();
  const releaseWrite = deferred<void>();
  let nextCalls = 0;
  const events: AsyncIterable<SseFrame> = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          nextCalls += 1;
          return nextCalls === 1
            ? { done: false, value: sseFrame('{}') }
            : closedIteratorResult();
        },
      };
    },
  };
  const stream = fakeSSEStream(async () => {
    writeStarted.resolve();
    await releaseWrite.promise;
  });

  const completion = writeSSEFrames(stream, events);
  await writeStarted.promise;
  expect(nextCalls).toBe(1);

  releaseWrite.resolve();
  await expect(completion).resolves.toBe('eof');
  expect(nextCalls).toBe(2);
});
