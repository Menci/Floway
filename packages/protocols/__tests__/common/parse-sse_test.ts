import { test } from 'vitest';

import { parseSSEStream } from '../../src/common/parse-sse.ts';
import { assertEquals } from '@floway-dev/test-utils';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });

  return { promise, resolve };
};

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

const collect = async (text: string) => {
  const frames = [];
  for await (const frame of parseSSEStream(new Response(text).body!)) {
    frames.push(frame);
  }
  return frames;
};

test('parseSSEStream flushes a final data line without a trailing newline', async () => {
  assertEquals(await collect('event: message_delta\ndata: not json'), [
    {
      type: 'sse',
      event: 'message_delta',
      data: 'not json',
    },
  ]);
});

test('parseSSEStream accepts fields without the optional space after the colon', async () => {
  assertEquals(await collect([
    'event:message_start',
    'data:{"type":"message_start"}',
    '',
    'event:message_stop',
    'data:{"type":"message_stop"}',
    '',
  ].join('\n')), [
    {
      type: 'sse',
      event: 'message_start',
      data: '{"type":"message_start"}',
    },
    {
      type: 'sse',
      event: 'message_stop',
      data: '{"type":"message_stop"}',
    },
  ]);
});

test('parseSSEStream joins data fields and resets event state at blank-line boundaries', async () => {
  assertEquals(await collect([
    ': ignored comment',
    'event:update',
    'data:first',
    'data:  second',
    'data:third ',
    '',
    'event:orphaned',
    '',
    'data:tail',
    '',
  ].join('\n')), [
    {
      type: 'sse',
      event: 'update',
      data: 'first\n second\nthird ',
    },
    {
      type: 'sse',
      event: undefined,
      data: 'tail',
    },
  ]);
});

test('parseSSEStream cancels a pending reader when its signal aborts', async () => {
  const upstreamCanceled = deferred<void>();
  let upstreamController!: ReadableStreamDefaultController<Uint8Array>;
  const downstreamAbortController = new AbortController();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      upstreamController = controller;
    },
    cancel() {
      upstreamCanceled.resolve();
    },
  });
  const iterator = parseSSEStream(body, {
    signal: downstreamAbortController.signal,
  });
  const pendingNext = iterator.next();

  try {
    await waitForMicrotasks();
    downstreamAbortController.abort();

    const cancelState = await cancelStateWithin(upstreamCanceled.promise, 20);

    assertEquals(cancelState, 'canceled');
    assertEquals(await pendingNext, { done: true, value: undefined });
  } finally {
    try {
      upstreamController.close();
    } catch {
      // The stream is already canceled in the passing path.
    }
    await iterator.return(undefined).catch(() => {});
  }
});
