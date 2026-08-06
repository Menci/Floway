import { expect, test } from 'vitest';

import { byteStream, collectAsync } from './test-utils.ts';
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
  return await collectAsync(parseSSEStream(byteStream(text)));
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

test('parseSSEStream preserves Unicode split at every byte boundary', async () => {
  const bytes = new TextEncoder().encode('event: update\r\ndata: A😀中\r\n\r\n');
  const chunks = Array.from(bytes, byte => new Uint8Array([byte]));

  assertEquals(await collectAsync(parseSSEStream(byteStream(...chunks))), [
    { type: 'sse', event: 'update', data: 'A😀中' },
  ]);
});

test('parseSSEStream rejects invalid UTF-8 rather than replacing upstream bytes', async () => {
  const prefix = new TextEncoder().encode('data: {"text":"');
  const suffix = new TextEncoder().encode('"}\n\n');
  const invalid = new Uint8Array(prefix.length + 1 + suffix.length);
  invalid.set(prefix);
  invalid[prefix.length] = 0xff;
  invalid.set(suffix, prefix.length + 1);

  await expect(collectAsync(parseSSEStream(byteStream(invalid)))).rejects.toThrow(TypeError);
});

test('parseSSEStream preserves a decode failure when reader cancellation also fails', async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([0xff]));
    },
    cancel() {
      throw new Error('cancel failed');
    },
  });

  const error = await collectAsync(parseSSEStream(body)).then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(TypeError);
  expect((error as Error).cause).toEqual(new Error('cancel failed'));
});

test('parseSSEStream preserves a frozen stream failure when cancellation also fails', async () => {
  const primary = Object.freeze(new Error('read failed'));
  const body = new ReadableStream<Uint8Array>({
    pull() {
      throw primary;
    },
    cancel() {
      throw new Error('cancel failed');
    },
  });

  const error = await collectAsync(parseSSEStream(body)).then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBe(primary);
});

test('parseSSEStream returns promptly when cancellation never settles', async () => {
  const controller = new AbortController();
  controller.abort(new DOMException('stopped', 'AbortError'));
  let cancellations = 0;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancellations++;
      return new Promise<void>(() => {});
    },
  });

  const result = parseSSEStream(body, { signal: controller.signal }).next();
  await expect(Promise.race([
    result,
    new Promise((_, reject) => setTimeout(() => reject(new Error('parser remained pending')), 50)),
  ])).resolves.toEqual({ done: true, value: undefined });
  expect(cancellations).toBe(1);
  expect(body.locked).toBe(false);
});

test('parseSSEStream surfaces prompt cancellation rejection after abort', async () => {
  const cleanup = new Error('cancel failed');
  const controller = new AbortController();
  const body = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise<void>(() => {});
    },
    cancel() {
      return Promise.reject(cleanup);
    },
  }, { highWaterMark: 0 });
  const pending = parseSSEStream(body, { signal: controller.signal }).next();
  await waitForMicrotasks();

  controller.abort(new DOMException('stopped', 'AbortError'));

  await expect(pending).rejects.toBe(cleanup);
  expect(body.locked).toBe(false);
});

test('parseSSEStream counts raw event bytes across chunks and resets at blank lines', async () => {
  const first = new TextEncoder().encode('data:x\r\n\r\n');
  const second = new TextEncoder().encode('data:y\r\n\r\n');
  const chunks = [...first, ...second].map(byte => Uint8Array.of(byte));

  await expect(collectAsync(parseSSEStream(byteStream(...chunks), {
    maxEventBytes: first.byteLength,
  }))).resolves.toEqual([
    { type: 'sse', event: undefined, data: 'x' },
    { type: 'sse', event: undefined, data: 'y' },
  ]);
});

test('parseSSEStream rejects an oversized raw event before decoding its tail', async () => {
  const bytes = new TextEncoder().encode('data:oversized\n\n');
  let cancellationReason: unknown;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
    },
    cancel(reason) {
      cancellationReason = reason;
    },
  });

  const error = await collectAsync(parseSSEStream(body, { maxEventBytes: bytes.byteLength - 1 })).then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toMatchObject({
    maxEventBytes: bytes.byteLength - 1,
    message: `Upstream SSE event exceeded ${bytes.byteLength - 1} raw bytes`,
    name: 'SseEventByteLimitError',
  });
  expect(cancellationReason).toBe(error);
  expect(body.locked).toBe(false);
});

test('parseSSEStream bounds consecutive empty chunks', async () => {
  let cancellations = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array());
    },
    cancel() {
      cancellations++;
    },
  }, { highWaterMark: 0 });

  await expect(collectAsync(parseSSEStream(body, {
    maxConsecutiveEmptyChunks: 2,
  }))).rejects.toThrow('Upstream SSE stream exceeded 2 consecutive empty chunks');
  expect(cancellations).toBe(1);
  expect(body.locked).toBe(false);
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
