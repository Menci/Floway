import { expect, it, vi } from 'vitest';

import { closed, done, enter, leave, runEvent } from './fixtures.ts';
import { createDumpDecoder, createDumpPump } from '../src/index.ts';
import type { EncodedDumpEvent } from '../src/index.ts';

const collect = async (artifact: ReadableStream<Uint8Array>): Promise<string> => await new Response(artifact).text();
const lines = (artifact: string): EncodedDumpEvent[] => artifact.trimEnd().split('\n').map(line => JSON.parse(line) as EncodedDumpEvent);

it('enqueues a live fact by identity and starts serialization in a later turn', async () => {
  const reads = vi.fn();
  const facts = new Proxy(Object.freeze({ observed: 1 }), {
    ownKeys(target) {
      reads();
      return Reflect.ownKeys(target);
    },
  });
  const pump = createDumpPump();
  const artifact = collect(pump.artifact);
  for (const event of [runEvent, enter(2, 1, facts), leave(3, 1, facts), closed(4, 1), done(5)]) pump.sink(event);
  expect(reads).not.toHaveBeenCalled();
  await Promise.resolve();
  expect(reads).not.toHaveBeenCalled();
  const [written, summary] = await Promise.all([artifact, pump.completed]);
  expect(reads).toHaveBeenCalledTimes(1);
  expect(lines(written).map(event => event.k)).toEqual(['run', 'obj', 'enter', 'leave', 'closed', 'done']);
  expect(summary).toEqual({ totalBytes: new TextEncoder().encode(written).byteLength, truncated: false, droppedEvents: 0, ok: true });
});

it('finishes the artifact while a lagged live observer is blocked', async () => {
  const enteredLive = Promise.withResolvers<void>();
  const releaseLive = Promise.withResolvers<void>();
  const endedLive = Promise.withResolvers<void>();
  const onLiveChunk = vi.fn(async () => {
    enteredLive.resolve();
    await releaseLive.promise;
  });
  const pump = createDumpPump({
    maxLiveBufferedBytes: 120,
    onLiveChunk,
    onLiveEnd: endedLive.resolve,
  });
  const artifact = collect(pump.artifact);
  pump.sink(runEvent);
  await enteredLive.promise;
  for (const event of [enter(2, 1, { text: 'a'.repeat(256) }), leave(3, 1, {}), closed(4, 1), done(5)]) pump.sink(event);
  try {
    const [written, summary] = await Promise.all([artifact, pump.completed]);
    expect(summary.truncated).toBe(false);
    expect(summary.droppedEvents).toBe(0);
    expect(pump.liveLagged).toBe(true);
    expect(onLiveChunk).toHaveBeenCalledTimes(1);
    expect(onLiveChunk.mock.calls[0]).toEqual([0, expect.any(Uint8Array)]);
    expect(lines(written).at(-1)).toMatchObject({ k: 'done', ok: true });
  } finally {
    releaseLive.resolve();
  }
  await endedLive.promise;
  expect(onLiveChunk).toHaveBeenCalledTimes(1);
});

it('reserves an ordered truncation marker and done within the artifact cap', async () => {
  const pump = createDumpPump({ maxArtifactBytes: 512, encoderOptions: { detectRawSecretLeaks: true } });
  const artifact = collect(pump.artifact);
  const hidden = 'not-encoded-after-the-cap';
  pump.registerSecretPlaintext(hidden);
  const error = { name: 'Error', message: 'late failure', stack: 'x'.repeat(600) };
  pump.sink(runEvent);
  pump.sink(enter(2, 1, {}));
  pump.sink({ k: 'stream', seq: 3, tMs: 3, stageId: 1, streamId: 1, label: 'body' });
  pump.sink({ k: 'frame', seq: 4, tMs: 4, streamId: 1, value: 'x'.repeat(700) });
  pump.sink({ k: 'frame', seq: 5, tMs: 5, streamId: 1, value: 'another frame' });
  pump.sink(leave(6, 1, { hidden }));
  pump.sink({ k: 'done', seq: 7, tMs: 7, ok: false, error });
  const [written, summary] = await Promise.all([artifact, pump.completed]);
  const events = lines(written);
  expect(summary).toMatchObject({ truncated: true, droppedEvents: 3, ok: false, doneError: error });
  expect(summary.totalBytes).toBe(new TextEncoder().encode(written).byteLength);
  expect(summary.totalBytes).toBeLessThanOrEqual(512);
  expect(events.slice(-2)).toEqual([
    { k: 'truncated', seq: 4, tMs: 4, reason: 'size-limit' },
    done(7, false),
  ]);
  expect(createDumpDecoder().pushNdjsonChunk(written).run?.done?.ok).toBe(false);
});

it('drops no events when only the done error exceeds the artifact cap', async () => {
  const pump = createDumpPump({ maxArtifactBytes: 1_024 });
  const artifact = collect(pump.artifact);
  const error = { name: 'Error', message: 'late failure', stack: 'x'.repeat(2_000) };
  for (const event of [runEvent, enter(2, 1, {}), leave(3, 1, {}), closed(4, 1)]) pump.sink(event);
  pump.sink({ k: 'done', seq: 5, tMs: 5, ok: false, error });

  const [written, summary] = await Promise.all([artifact, pump.completed]);
  const events = lines(written);
  expect(summary).toMatchObject({ truncated: true, droppedEvents: 0, doneError: error });
  expect(events.map(event => event.k)).toEqual(['run', 'obj', 'enter', 'obj', 'leave', 'closed', 'truncated', 'done']);
  expect(events.slice(-2)).toEqual([
    { k: 'truncated', seq: 5, tMs: 5, reason: 'size-limit' },
    done(5, false),
  ]);
});

it('rejects completion with the original artifact cancellation reason', async () => {
  const pump = createDumpPump();
  const error = new Error('writer failed');
  const checked = expect(pump.completed).rejects.toBe(error);
  await pump.artifact.cancel(error);
  await checked;
});
