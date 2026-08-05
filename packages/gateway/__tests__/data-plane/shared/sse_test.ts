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
  const started = deferred<void>();
  const returned = deferred<void>();

  const events: AsyncIterable<SseFrame> = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          pendingNext = deferred<IteratorResult<SseFrame>>();
          started.resolve();
          return pendingNext.promise;
        },
        return() {
          returnCalled = true;
          returned.resolve();
          pendingNext?.resolve(closedIteratorResult());
          return Promise.resolve(closedIteratorResult());
        },
      };
    },
  };

  return {
    events,
    started: started.promise,
    returned: returned.promise,
    rejectNext: (error: unknown) => pendingNext?.reject(error),
    returnCalled: () => returnCalled,
  };
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

  try {
    const response = await requestSSE(idle.events, {
      keepAlive: { intervalMs: 1_000, frame: sseCommentFrame('keepalive') },
    });
    const reader = response.body!.getReader();

    await idle.started;
    const read = reader.read();
    await time.tickAsync(1_000);

    const chunk = await read;
    assertEquals(decodeChunk(chunk.value), ': keepalive\n\n');

    await reader.cancel();
    await idle.returned;
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

    await idle.started;
    const read = reader.read();
    await time.tickAsync(1_000);

    const chunk = await read;
    assertEquals(decodeChunk(chunk.value), 'event: ping\ndata: {"type":"ping"}\n\n');

    await reader.cancel();
    await idle.returned;
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

    await idle.started;
    await reader.cancel();
    await idle.returned;

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

  await idle.started;
  const cancelResponse = reader.cancel();
  idle.rejectNext(new Error('late upstream stream failure'));
  await idle.returned;
  await cancelResponse;

  assertEquals(idle.returnCalled(), true);
});

test('writeSSEFrames aborts a pending upstream SSE reader when the downstream response is canceled', async () => {
  const upstreamCanceled = deferred<void>();
  const upstreamReadStarted = deferred<void>();
  let upstreamController!: ReadableStreamDefaultController<Uint8Array>;
  const downstreamAbortController = new AbortController();
  const upstreamBody = new ReadableStream<Uint8Array>({
    start(controller) {
      upstreamController = controller;
    },
    pull() {
      upstreamReadStarted.resolve();
    },
    cancel() {
      upstreamCanceled.resolve();
    },
  }, { highWaterMark: 0 });
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
    await upstreamReadStarted.promise;
    cancelResponse = reader.cancel();
    await upstreamCanceled.promise;
    assertEquals(downstreamAbortController.signal.aborted, true);
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

for (const failurePoint of ['next', 'write'] as const) {
  test(`writeSSEFrames preserves a ${failurePoint} failure when iterator cleanup also fails`, async () => {
    const primaryError = new Error(`${failurePoint} failed`);
    const cleanupError = new Error('iterator cleanup failed');
    const downstreamAbortController = new AbortController();
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

    const error = await writeSSEFrames(stream, events, { downstreamAbortController }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).message).toBe(primaryError.message);
    expect((error as AggregateError).cause).toBe(primaryError);
    expect((error as AggregateError).errors).toEqual([primaryError, cleanupError]);
    expect(downstreamAbortController.signal.aborted).toBe(true);
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
