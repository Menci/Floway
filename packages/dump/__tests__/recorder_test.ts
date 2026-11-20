import { expect, test } from 'vitest';

import { eventsOf, metadata } from './fixtures.ts';
import { createRunRecorder, type StoredDumpRecord } from '../src/index.ts';
import { compose, createRunReader, defer, defineStage, move, run } from '@floway-dev/pipeline';

test('a native pipeline round-trips facts, shared frame values and deferred outcomes through one object space', async () => {
  const written: StoredDumpRecord[] = [];
  const recorder = createRunRecorder({ write: async record => { written.push(record); }, publish: async () => {} });
  const shared = move({ text: 'Recorded 中', nested: { count: 7 } });
  const pending = Promise.withResolvers<typeof shared>();
  const deferred = defer(pending.promise);
  const stream = recorder.openStream();
  const streamFact = move(stream.fact);
  const answer = defineStage<{ payload: typeof shared }, {
    left: typeof shared;
    right: typeof shared;
    pending: typeof deferred;
    stream: typeof streamFact;
  }>({
    name: 'answer',
    return: { provides: ['left', 'right', 'pending', 'stream'] },
    execute: async (facts, use) => {
      await use.log.info('prepared', { payload: facts.payload });
      return move({ ...facts, left: facts.payload, right: facts.payload, pending: deferred, stream: streamFact });
    },
  });

  const result = await run(compose('recorded', [answer]), move({ payload: shared }), { dump: recorder.sink });
  await stream.frame(shared);
  await stream.end();
  pending.resolve(shared);
  await result.drain();
  await recorder.finish(metadata());

  expect(written).toHaveLength(1);
  const events = eventsOf(written[0]!);
  expect(events[0]?.type).toBe('object');
  expect(events.filter(event => event.type === 'stage.entered').map(event => event.name)).toEqual(['answer']);
  expect(events.filter(event => event.type === 'stage.log').map(event => event.message)).toEqual(['prepared']);
  const read = createRunReader();
  const decoded = events.map(event => read(event));
  const returned = decoded.find(value => value?.facts && 'left' in value.facts)!.facts!;
  const frame = decoded.find(value => value?.frames)!.frames![0];
  const settled = decoded.find(value => value?.outcome)!.outcome!;
  expect(returned.left).toEqual(shared);
  expect(returned.left).toBe(returned.right);
  expect(frame).toBe(returned.left);
  expect(settled.status).toBe('fulfilled');
  if (settled.status !== 'fulfilled') throw new Error('Expected the deferred result to fulfill');
  expect(settled.value).toBe(returned.left);
  expect(returned.stream).toEqual({ stream: 1 });
});

test('publication waits for an observed storage write to complete', async () => {
  const entered = Promise.withResolvers<StoredDumpRecord>();
  const stored = Promise.withResolvers<void>();
  const order: string[] = [];
  const meta = metadata();
  const recorder = createRunRecorder({
    write: async record => { order.push('writing'); entered.resolve(record); await stored.promise; order.push('stored'); },
    publish: async value => { expect(value).toBe(meta); order.push('published'); },
  });
  recorder.sink({ type: 'stage.entered', stageId: 1, name: 'answer', parentStageId: null, facts: move({ input: '中' }) });
  const finishing = recorder.finish(meta);
  const record = await entered.promise;
  expect(record.meta).toBe(meta);
  expect(eventsOf(record).some(event => event.type === 'stage.entered')).toBe(true);
  expect(order).toEqual(['writing']);
  stored.resolve();
  await finishing;
  expect(order).toEqual(['writing', 'stored', 'published']);
});

test('an encoder failure retains its original exception and never stores or publishes a partial record', async () => {
  let writes = 0;
  let publications = 0;
  const recorder = createRunRecorder({ write: async () => { writes++; }, publish: async () => { publications++; } });
  let original: unknown;
  try {
    recorder.sink({ type: 'stage.entered', stageId: 1, name: 'invalid', parentStageId: null, facts: move({ upload: new Blob(['source bytes']) }) });
  } catch (error) { original = error; }
  expect(original).toBeInstanceOf(TypeError);
  expect((original as Error).message).toContain('Blob');
  let subsequent: unknown;
  try {
    recorder.sink({ type: 'stage.failed', stageId: 1, error: original });
  } catch (error) { subsequent = error; }
  expect(subsequent).toBe(original);
  await expect(recorder.finish(metadata({ status: 500 }))).rejects.toBe(original);
  expect(writes).toBe(0);
  expect(publications).toBe(0);
});

test('storage rejection propagates the original error and prevents publication', async () => {
  const original = new Error('durable storage failed');
  let publications = 0;
  const recorder = createRunRecorder({ write: async () => { throw original; }, publish: async () => { publications++; } });
  await recorder.frame({ type: 'event', event: { text: 'recorded' } });
  await expect(recorder.finish(metadata())).rejects.toBe(original);
  expect(publications).toBe(0);
});

test('publication rejection preserves its original error after the complete record exists', async () => {
  const original = new Error('broker failed');
  const written: StoredDumpRecord[] = [];
  const recorder = createRunRecorder({ write: async record => { written.push(record); }, publish: async () => { throw original; } });
  await recorder.frame({ type: 'event', event: { text: 'recorded' } });
  await expect(recorder.finish(metadata())).rejects.toBe(original);
  expect(written).toHaveLength(1);
  expect(eventsOf(written[0]!).filter(event => event.type === 'stream.frame')).toHaveLength(1);
});

test('direct frames share a stream and separately opened streams retain distinct references', async () => {
  const written: StoredDumpRecord[] = [];
  const recorder = createRunRecorder({ write: async record => { written.push(record); }, publish: async () => {} });
  await recorder.frame({ type: 'event', event: 'first' });
  await recorder.frame({ type: 'event', event: 'second' });
  const independent = recorder.openStream();
  await independent.frame({ type: 'event', event: 'other' });
  await independent.end();
  await recorder.finish(metadata());
  const events = eventsOf(written[0]!);
  expect(events.filter(event => event.type === 'stream.frame').map(event => event.streamId)).toEqual([1, 1, 2]);
  expect(events.filter(event => event.type === 'stream.end').map(event => event.streamId)).toEqual([2]);
});
