import { afterEach, expect, test, vi } from 'vitest';

import { DurableObjectLogStreamStore } from '../src/durable-object-log-stream.ts';
import { LogStreamDO } from '../src/log-stream-do.ts';
import { LogStreamResponse, LogStreamState, LogStreamWebSocketPair } from './test-utils/log-stream.ts';
import {
  LOG_STREAM_IDLE_MS,
  LogStreamEndedError,
  LogStreamExpiredError,
  LogStreamHoleError,
} from '@floway-dev/platform';

const setup = () => {
  const state = new LogStreamState();
  const actor = new LogStreamDO(state, {});
  vi.stubGlobal('Response', LogStreamResponse);
  vi.stubGlobal('WebSocketPair', LogStreamWebSocketPair);
  const store = new DurableObjectLogStreamStore({ idFromName: name => name, get: () => actor });
  return { state, actor, store };
};

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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test('read-only attachment does not create a missing Durable Object', async () => {
  const { actor, store, state } = setup();
  await expect(store.get('missing')).resolves.toBeNull();
  expect(await actor.fetch(new Request('https://log-stream/read?fromOffset=0'))).toHaveProperty('status', 404);
  expect(state.storage.alarm).toBeNull();
  expect([...state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'")]).toEqual([]);
});

test('the adapter maps hole and ended outcomes and reads exact retry bytes', async () => {
  const { store } = setup();
  const stream = await store.open('run');
  await stream.append(0, new Uint8Array([1, 2]));
  await expect(stream.append(5, new Uint8Array([3]))).rejects.toBeInstanceOf(LogStreamHoleError);
  await stream.append(0, new Uint8Array([1, 2, 3]));
  await stream.end();
  await stream.append(0, new Uint8Array([1, 2, 3]));
  await expect(stream.append(3, new Uint8Array([4]))).rejects.toBeInstanceOf(LogStreamEndedError);
  await expect(drain(stream.read(1, new AbortController().signal))).resolves.toEqual(new Uint8Array([2, 3]));
});

test('an expired handle reconstructs the platform expiration error', async () => {
  vi.useFakeTimers();
  const { store, actor } = setup();
  const stream = await store.open('expired');
  await stream.append(0, new Uint8Array([1, 2, 3]));
  await vi.advanceTimersByTimeAsync(LOG_STREAM_IDLE_MS);
  await actor.alarm();
  await expect(store.get('expired')).resolves.toBeNull();
  await expect(stream.append(3, new Uint8Array())).rejects.toBeInstanceOf(LogStreamExpiredError);
});

test('a paused reader pulls one segment at a time instead of queueing the backlog', async () => {
  const { store, actor, state } = setup();
  const stream = await store.open('backpressure');
  const readChunk = vi.spyOn(actor, 'readChunk');
  const reader = stream.read(0, new AbortController().signal)[Symbol.asyncIterator]();
  const first = reader.next();
  await Promise.resolve();
  await stream.append(0, new Uint8Array(4 * 1024 * 1024));

  expect((await first).value?.byteLength).toBe(64 * 1024);
  const calls = readChunk.mock.calls.length;
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(readChunk).toHaveBeenCalledTimes(calls);
  expect(state.sockets.flatMap(socket => socket.sent)).toEqual(['changed']);
  expect((await reader.next()).value?.byteLength).toBe(64 * 1024);
  expect(readChunk).toHaveBeenCalledTimes(calls + 1);
  await reader.return?.();
});

test('expiration interrupts an attached reader with the expired close code', async () => {
  vi.useFakeTimers();
  const { store, actor } = setup();
  const stream = await store.open('reading');
  const pending = stream.read(0, new AbortController().signal)[Symbol.asyncIterator]().next();
  const rejected = expect(pending).rejects.toBeInstanceOf(LogStreamExpiredError);
  await vi.advanceTimersByTimeAsync(LOG_STREAM_IDLE_MS);
  await actor.alarm();
  await rejected;
});

test('a server WebSocket error interrupts the reader and preserves the original exception', async () => {
  const { store, actor, state } = setup();
  const stream = await store.open('failed-reader');
  const pending = stream.read(0, new AbortController().signal)[Symbol.asyncIterator]().next();
  await Promise.resolve();
  const failure = new Error('socket failed');
  await expect(actor.webSocketError(state.getWebSockets()[0]!, failure)).rejects.toBe(failure);
  await expect(pending).rejects.toThrow('interrupted');
});

test('a reader waiting at the tail wakes when the server closes the stream', async () => {
  const { store, actor, state } = setup();
  const stream = await store.open('tail-close');
  const reader = stream.read(0, new AbortController().signal)[Symbol.asyncIterator]();
  const pending = reader.next();
  await Promise.resolve();
  await actor.end();
  await expect(pending).resolves.toEqual({ done: true, value: undefined });
  expect(state.sockets[0]?.closed).toEqual({ code: 1000, reason: 'ended' });
});
