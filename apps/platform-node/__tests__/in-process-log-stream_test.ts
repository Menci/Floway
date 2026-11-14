import { expect, test, vi } from 'vitest';

import { InProcessLogStreamStore } from '../src/in-process-log-stream.ts';
import { LOG_STREAM_IDLE_MS, LogStreamEndedError, LogStreamExpiredError, LogStreamHoleError } from '@floway-dev/platform';
import { assertEquals } from '@floway-dev/test-utils';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const drain = async (stream: AsyncIterable<Uint8Array>): Promise<string> => {
  let out = '';
  for await (const chunk of stream) out += decoder.decode(chunk, { stream: true });
  return out + decoder.decode();
};

test('a reader attaching after end still gets everything', async () => {
  const store = new InProcessLogStreamStore();
  const stream = await store.open('run-1');
  await stream.append(0, encoder.encode('one\n'));
  await stream.append(4, encoder.encode('two\n'));
  await stream.end();

  assertEquals(await drain(stream.read(0, new AbortController().signal)), 'one\ntwo\n');
});

test('a reader follows the tail and completes when the stream ends', async () => {
  const store = new InProcessLogStreamStore();
  const stream = await store.open('run-2');
  const reading = drain(stream.read(0, new AbortController().signal));

  await stream.append(0, encoder.encode('a\n'));
  await stream.append(2, encoder.encode('b\n'));
  await stream.end();

  assertEquals(await reading, 'a\nb\n');
});

test('fromOffset resumes where an interrupted reader stopped', async () => {
  const store = new InProcessLogStreamStore();
  const stream = await store.open('run-3');
  await stream.append(0, encoder.encode('first\n'));
  await stream.append(6, encoder.encode('second\n'));
  await stream.end();

  // The offset lives in the caller, which is what keeps re-reading cheap without a
  // server-side cursor and without a seam between backlog and live tail.
  assertEquals(await drain(stream.read(6, new AbortController().signal)), 'second\n');
});

test('a retry at an offset already written contributes only what is new', async () => {
  const store = new InProcessLogStreamStore();
  const stream = await store.open('run-4');
  await stream.append(0, encoder.encode('hello'));
  // The writer could not tell whether the first append landed, so it retries — re-chunked,
  // subsuming the earlier attempt. Resolving by position is what makes that the same bytes in
  // the same places rather than a duplicated splice.
  await stream.append(0, encoder.encode('hello world'));
  await stream.end();

  assertEquals(await drain(stream.read(0, new AbortController().signal)), 'hello world');
});

test('an append beyond the end is a hole and is refused', async () => {
  const store = new InProcessLogStreamStore();
  const stream = await store.open('run-5');
  await stream.append(0, encoder.encode('abc'));

  let raised: unknown;
  try {
    await stream.append(10, encoder.encode('xyz'));
  } catch (error) {
    raised = error;
  }
  assertEquals(raised instanceof LogStreamHoleError, true);
});

test('an aborted read throws rather than completing', async () => {
  const store = new InProcessLogStreamStore();
  const stream = await store.open('run-6');
  await stream.append(0, encoder.encode('partial\n'));
  const controller = new AbortController();
  const reading = drain(stream.read(0, controller.signal));
  controller.abort();

  // Completing normally would say "the stream ended", which is the one thing an interrupted
  // read must not claim.
  let raised: unknown;
  try {
    await reading;
  } catch (error) {
    raised = error;
  }
  assertEquals(raised instanceof Error, true);
});

test('concurrent writers open the same stream and absent readers create nothing', async () => {
  const store = new InProcessLogStreamStore();
  expect(await store.get('missing')).toBeNull();
  const [first, second] = await Promise.all([store.open('same'), store.open('same')]);
  expect(first).toBe(second);
  await first.end();
});

test('an empty heartbeat keeps a quiet live writer through long first-token and mid-stream waits', async () => {
  vi.useFakeTimers();
  try {
    const store = new InProcessLogStreamStore();
    const stream = await store.open('long-model');
    for (let elapsed = 0; elapsed < 120_000; elapsed += LOG_STREAM_IDLE_MS / 3) {
      await vi.advanceTimersByTimeAsync(LOG_STREAM_IDLE_MS / 3);
      await stream.append(0, new Uint8Array());
      expect(await store.get('long-model')).toBe(stream);
    }
    await stream.append(0, encoder.encode('first'));
    for (let elapsed = 0; elapsed < 120_000; elapsed += LOG_STREAM_IDLE_MS / 3) {
      await vi.advanceTimersByTimeAsync(LOG_STREAM_IDLE_MS / 3);
      await stream.append(5, new Uint8Array());
    }
    await stream.append(5, encoder.encode(' last'));
    await stream.end();
    expect(await drain(stream.read(0, new AbortController().signal))).toBe('first last');
    await vi.advanceTimersByTimeAsync(LOG_STREAM_IDLE_MS);
    expect(await store.get('long-model')).toBeNull();
  } finally { vi.useRealTimers(); }
});

test('abandoned writers expire and interrupt attached readers', async () => {
  vi.useFakeTimers();
  try {
    const store = new InProcessLogStreamStore();
    const stream = await store.open('abandoned');
    const reading = drain(stream.read(0, new AbortController().signal));
    const rejected = expect(reading).rejects.toBeInstanceOf(LogStreamExpiredError);
    await vi.advanceTimersByTimeAsync(LOG_STREAM_IDLE_MS);
    await rejected;
    expect(await store.get('abandoned')).toBeNull();
    await expect(stream.append(0, encoder.encode('late'))).rejects.toBeInstanceOf(LogStreamExpiredError);
  } finally { vi.useRealTimers(); }
});

test('read progress keeps a finished backlog available until reading completes', async () => {
  vi.useFakeTimers();
  try {
    const store = new InProcessLogStreamStore();
    const stream = await store.open('slow-reader');
    const bytes = new Uint8Array(3 * 64 * 1024);
    await stream.append(0, bytes);
    await stream.end();
    const reader = stream.read(0, new AbortController().signal)[Symbol.asyncIterator]();
    for (let index = 0; index < 3; index++) {
      await vi.advanceTimersByTimeAsync(LOG_STREAM_IDLE_MS / 2);
      expect((await reader.next()).value?.byteLength).toBe(64 * 1024);
      expect(await store.get('slow-reader')).toBe(stream);
    }
    expect((await reader.next()).done).toBe(true);
    await vi.advanceTimersByTimeAsync(LOG_STREAM_IDLE_MS);
    expect(await store.get('slow-reader')).toBeNull();
  } finally { vi.useRealTimers(); }
});

test('ending seals new bytes while accepting a duplicate append acknowledgement retry', async () => {
  const store = new InProcessLogStreamStore();
  const stream = await store.open('sealed');
  await stream.append(0, encoder.encode('done'));
  await stream.end();
  await stream.append(0, encoder.encode('done'));
  await expect(stream.append(4, encoder.encode('new'))).rejects.toBeInstanceOf(LogStreamEndedError);
  expect(await drain(stream.read(0, new AbortController().signal))).toBe('done');
});
