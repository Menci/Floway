import { Hono } from 'hono';
import { expect, test, vi } from 'vitest';

import { serializeSseFrame, serveSse, type SseOutcome } from '../../../src/data-plane/shared/sse.ts';
import { FakeTime } from '../../test-time.ts';
import { parseSSEStream } from '@floway-dev/protocols/common';
import { sseCommentFrame, type SseFrame, type SseWritableFrame, sseFrame, sseRawFrame } from '@floway-dev/protocols/common';
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

type TestOptions = Omit<Parameters<typeof serveSse<SseWritableFrame>>[1], 'events'>;

const requestSSE = async (events: AsyncIterable<SseWritableFrame>, options: Partial<TestOptions>): Promise<Response> => {
  const app = new Hono();
  app.get('/', c =>
    serveSse(c, {
      events,
      downstreamAbortController: undefined,
      protocol: {
        encode: frame => ({ wire: serializeSseFrame(frame) }),
        eof: () => ({ type: 'completed' }),
        failure: () => [serializeSseFrame(sseFrame('failure'))],
      },
      settle: () => {},
      ...options,
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

test('SSE egress emits comment keepalive frames while idle', async () => {
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

test('SSE egress emits a data keepalive frame by default', async () => {
  const time = new FakeTime();
  const idle = createIdleSSEEvents();

  try {
    const response = await requestSSE(idle.events, {});
    const reader = response.body!.getReader();

    await waitForIteratorStart(idle);
    const read = reader.read();
    await time.tickAsync(15_000);

    const chunk = await read;
    assertEquals(decodeChunk(chunk.value), 'event: ping\ndata: {"type":"ping"}\n\n');

    await reader.cancel();
  } finally {
    time.restore();
  }
});

test('SSE egress settles cancellation once without rendering a racing iterator error', async () => {
  const idle = createIdleSSEEvents();
  const settle = vi.fn<(outcome: SseOutcome) => void>();
  const failure = vi.fn<TestOptions['protocol']['failure']>(() => [serializeSseFrame(sseFrame('unexpected failure'))]);
  const response = await requestSSE(idle.events, {
    protocol: { encode: frame => ({ wire: serializeSseFrame(frame) }), eof: () => ({ type: 'completed' }), failure },
    settle,
  });
  const reader = response.body!.getReader();

  await waitForIteratorStart(idle);
  await reader.cancel();
  idle.rejectNext(new Error('late upstream stream failure'));
  await waitForIteratorReturn(idle);

  assertEquals(idle.returnCalled(), true);
  await vi.waitFor(() => expect(settle.mock.calls).toEqual([[{ type: 'cancelled' }]]));
  expect(failure).not.toHaveBeenCalled();
});

test('SSE egress aborts a pending upstream SSE reader when the downstream response is canceled', async () => {
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

test('SSE egress writes a raw frame without SSE field framing', async () => {
  const data = JSON.stringify({ error: { code: 500, status: 'INTERNAL', message: 'failure' } });
  const frames = async function* () {
    yield sseFrame('{"candidates":[]}');
    yield sseRawFrame(data);
  };
  const response = await requestSSE(frames(), {});
  assertEquals(await response.text(), `data: {"candidates":[]}\n\n${data}`);
});

test('SSE serialization emits a data field for every line of a named event', () => {
  const wire = serializeSseFrame(sseFrame('first\r\nsecond\r\n\nlast', 'message'));
  expect(wire).toBe('event: message\ndata: first\ndata: second\ndata: \ndata: last\n\n');
});

test.each(['read', 'encode', 'eof'] as const)('SSE egress renders and settles a %s failure after earlier output', async failureAt => {
  const error = new Error(`failed at ${failureAt}`);
  const settle = vi.fn<(outcome: SseOutcome) => void>();
  const failure = vi.fn<TestOptions['protocol']['failure']>(() => [serializeSseFrame(sseFrame('protocol failure'))]);
  const frames = async function* () {
    yield sseFrame('partial');
    if (failureAt === 'read') throw error;
    if (failureAt === 'encode') yield sseFrame('unencodable');
  };
  const response = await requestSSE(frames(), {
    protocol: {
      encode: frame => {
        if (frame.type === 'sse' && frame.data === 'unencodable') throw error;
        return { wire: serializeSseFrame(frame) };
      },
      eof: () => ({ type: 'premature-eof', error }),
      failure,
    },
    settle,
  });
  expect(await response.text()).toBe('data: partial\n\ndata: protocol failure\n\n');
  expect(failure.mock.calls).toEqual([[error]]);
  expect(settle.mock.calls).toEqual([[{ type: failureAt === 'eof' ? 'premature-eof' : 'source-error', error }]]);
});

test('SSE egress closes the iterator at a protocol terminal without pulling another frame', async () => {
  const closed = vi.fn();
  const settle = vi.fn<(outcome: SseOutcome) => void>();
  const frames = async function* () {
    try {
      yield sseFrame('terminal');
      throw new Error('trailing read');
    } finally {
      closed();
    }
  };
  const response = await requestSSE(frames(), {
    protocol: {
      encode: frame => ({
        wire: serializeSseFrame(frame),
        end: { type: 'protocol-error', trailer: [serializeSseFrame(sseFrame('trailer'))] },
      }),
      eof: () => { throw new Error('unexpected EOF'); },
      failure: () => [serializeSseFrame(sseFrame('unexpected failure'))],
    },
    settle,
  });
  expect(await response.text()).toBe('data: terminal\n\ndata: trailer\n\n');
  expect(closed).toHaveBeenCalledOnce();
  expect(settle.mock.calls).toEqual([[{ type: 'protocol-error' }]]);
});
