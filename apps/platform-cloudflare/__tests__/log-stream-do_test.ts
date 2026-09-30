import { afterEach, expect, test, vi } from 'vitest';

import { DurableObjectLogStreamStore } from '../src/durable-object-log-stream.ts';
import { LogStreamDO } from '../src/log-stream-do.ts';
import { LogStreamResponse, LogStreamState, LogStreamWebSocketPair } from './test-utils/log-stream.ts';
import { LOG_STREAM_IDLE_MS, LogStreamEndedError, LogStreamExpiredError, LogStreamHoleError } from '@floway-dev/platform';

const setup = () => {
  const state = new LogStreamState();
  const actor = new LogStreamDO(state, {});
  vi.stubGlobal('Response', LogStreamResponse);
  vi.stubGlobal('WebSocketPair', LogStreamWebSocketPair);
  const store = new DurableObjectLogStreamStore({ idFromName: name => name, get: () => actor });
  return { state, actor, store };
};

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

test('read-only attachment does not create missing actor state', async () => {
  const { actor, store, state } = setup();
  expect(await store.get('missing')).toBeNull();
  expect(await actor.fetch(new Request('https://log-stream/read?fromOffset=0'))).toHaveProperty('status', 404);
  expect(state.storage.alarm).toBeNull();
  expect([...state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'")]).toEqual([]);
});

test('the RPC adapter reconstructs hole and ended errors and reads exact retry bytes', async () => {
  const { store } = setup();
  const stream = await store.open('run');
  await stream.append(0, new Uint8Array([1, 2]));
  await expect(stream.append(5, new Uint8Array([3]))).rejects.toBeInstanceOf(LogStreamHoleError);
  await stream.append(0, new Uint8Array([1, 2, 3]));
  await stream.end();
  await expect(stream.append(3, new Uint8Array([4]))).rejects.toBeInstanceOf(LogStreamEndedError);
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream.read(1, new AbortController().signal)) chunks.push(chunk);
  expect(chunks.map(chunk => [...chunk]).flat()).toEqual([2, 3]);
});

test('heartbeats keep an otherwise silent writer alive beyond two idle intervals', async () => {
  vi.useFakeTimers();
  const { store, actor } = setup();
  const stream = await store.open('quiet');
  for (let elapsed = 0; elapsed < 120_000; elapsed += LOG_STREAM_IDLE_MS / 3) {
    await vi.advanceTimersByTimeAsync(LOG_STREAM_IDLE_MS / 3);
    await stream.append(0, new Uint8Array());
    await actor.alarm();
    expect(await store.get('quiet')).not.toBeNull();
  }
  await stream.append(0, new Uint8Array([9]));
  await stream.end();
});

test('an abandoned writer is reclaimed and existing handles see expiration', async () => {
  vi.useFakeTimers();
  const { store, actor, state } = setup();
  const stream = await store.open('abandoned');
  await stream.append(0, new Uint8Array([9]));
  await vi.advanceTimersByTimeAsync(LOG_STREAM_IDLE_MS);
  await actor.alarm();
  expect(await store.get('abandoned')).toBeNull();
  expect(state.storage.alarm).toBeNull();
  await expect(stream.append(1, new Uint8Array([10]))).rejects.toBeInstanceOf(LogStreamExpiredError);
});

test('expiration interrupts an attached reader instead of signaling clean completion', async () => {
  vi.useFakeTimers();
  const { store, actor } = setup();
  const stream = await store.open('reading');
  const reader = stream.read(0, new AbortController().signal)[Symbol.asyncIterator]();
  const pending = reader.next();
  const rejected = expect(pending).rejects.toBeInstanceOf(LogStreamExpiredError);
  await vi.advanceTimersByTimeAsync(LOG_STREAM_IDLE_MS);
  await actor.alarm();
  await rejected;
});
