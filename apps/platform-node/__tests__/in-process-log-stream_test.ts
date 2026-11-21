import { expect, test, vi } from 'vitest';

import { InProcessLogStreamStore } from '../src/in-process-log-stream.ts';
import {
  LOG_STREAM_IDLE_MS,
  LogStreamEndedError,
  LogStreamExpiredError,
  LogStreamHoleError,
} from '@floway-dev/platform';

const encoder = new TextEncoder();

const drain = async (stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    byteLength += chunk.byteLength;
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

test('a reader attaching after end still gets everything from its requested offset', async () => {
  const store = new InProcessLogStreamStore();
  const stream = await store.open('finished');
  await stream.append(0, encoder.encode('one\n'));
  await stream.append(4, encoder.encode('two\n'));
  await stream.end();

  await expect(drain(stream.read(0, new AbortController().signal))).resolves.toEqual(encoder.encode('one\ntwo\n'));
  await expect(drain(stream.read(4, new AbortController().signal))).resolves.toEqual(encoder.encode('two\n'));
});

test('multiple readers follow a live tail and resume cleanly from their offsets', async () => {
  const store = new InProcessLogStreamStore();
  const stream = await store.open('live');
  const first = drain(stream.read(0, new AbortController().signal));
  const second = drain(stream.read(2, new AbortController().signal));

  await stream.append(0, encoder.encode('abc'));
  await stream.append(3, encoder.encode('def'));
  await stream.end();

  await expect(first).resolves.toEqual(encoder.encode('abcdef'));
  await expect(second).resolves.toEqual(encoder.encode('cdef'));
});

test('overlapping retry appends contribute only new bytes and split at 64 KiB segments', async () => {
  const store = new InProcessLogStreamStore();
  const stream = await store.open('retry');
  const bytes = new Uint8Array(2 * 64 * 1024 + 17);
  for (let index = 0; index < bytes.byteLength; index++) bytes[index] = index % 251;

  await stream.append(0, bytes.subarray(0, 64 * 1024 + 9));
  await stream.append(0, bytes);
  await stream.end();

  const received = stream.read(0, new AbortController().signal)[Symbol.asyncIterator]();
  const lengths: number[] = [];
  for (;;) {
    const { done, value } = await received.next();
    if (done) break;
    lengths.push(value.byteLength);
  }
  expect(lengths).toEqual([64 * 1024, 64 * 1024, 17]);
  await expect(drain(stream.read(0, new AbortController().signal))).resolves.toEqual(bytes);
});

test('an append above the current length is rejected as a hole', async () => {
  const store = new InProcessLogStreamStore();
  const stream = await store.open('hole');
  await stream.append(0, encoder.encode('abc'));
  await expect(stream.append(10, encoder.encode('xyz'))).rejects.toBeInstanceOf(LogStreamHoleError);
});

test('ending permits idempotent acknowledgement retries and rejects new bytes', async () => {
  const store = new InProcessLogStreamStore();
  const stream = await store.open('ended');
  await stream.append(0, encoder.encode('done'));
  await stream.end();
  await stream.append(0, encoder.encode('done'));
  await expect(stream.append(4, encoder.encode('more'))).rejects.toBeInstanceOf(LogStreamEndedError);
});

test('aborting a waiting reader interrupts it instead of claiming the stream ended', async () => {
  const store = new InProcessLogStreamStore();
  const stream = await store.open('abort');
  const controller = new AbortController();
  const reading = drain(stream.read(0, controller.signal));
  controller.abort(new Error('reader stopped'));
  await expect(reading).rejects.toBe(controller.signal.reason);
});

test('an absent stream is not created by get() and concurrent opens share one stream', async () => {
  const store = new InProcessLogStreamStore();
  await expect(store.get('missing')).resolves.toBeNull();
  const [first, second] = await Promise.all([store.open('same'), store.open('same')]);
  expect(first).toBe(second);
  await first.end();
});

test('idle expiration removes the stream and interrupts an attached reader', async () => {
  vi.useFakeTimers();
  try {
    const store = new InProcessLogStreamStore();
    const stream = await store.open('expiring');
    const reading = drain(stream.read(0, new AbortController().signal));
    const rejected = expect(reading).rejects.toBeInstanceOf(LogStreamExpiredError);

    await vi.advanceTimersByTimeAsync(LOG_STREAM_IDLE_MS);
    await rejected;
    await expect(store.get('expiring')).resolves.toBeNull();
    await expect(stream.append(0, new Uint8Array([1]))).rejects.toBeInstanceOf(LogStreamExpiredError);
  } finally {
    vi.useRealTimers();
  }
});
