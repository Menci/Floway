import { expect, test } from 'vitest';

import { eventsOf, metadata, recordingFixture } from './fixtures.ts';
import type { StoredDumpRecord } from '../src/index.ts';
import { compose, createRunReader, defer, defineStage, move, run } from '@floway-dev/pipeline';

test('a native pipeline round-trips facts, shared frame values and deferred outcomes through one object space', async () => {
  const { recorder, records: written } = recordingFixture();
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
  await recorder.finish(async () => metadata());

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
  const { recorder } = recordingFixture({
    write: async run => {
      order.push('writing');
      const events = new Uint8Array(await new Response(run.events).arrayBuffer());
      entered.resolve({ meta: await run.metadata, events });
      await stored.promise;
      order.push('stored');
    },
    publish: async value => { expect(value).toBe(meta); order.push('published'); },
  });
  await recorder.sink({ type: 'stage.entered', stageId: 1, name: 'answer', parentStageId: null, facts: move({ input: '中' }) });
  const finishing = recorder.finish(async () => meta);
  const record = await entered.promise;
  expect(record.meta).toBe(meta);
  expect(eventsOf(record).some(event => event.type === 'stage.entered')).toBe(true);
  expect(order).toEqual(['writing']);
  stored.resolve();
  await finishing;
  expect(order).toEqual(['writing', 'stored', 'published']);
});

test('an encoder failure retains its original exception and never stores or publishes a partial record', async () => {
  const { recorder, records, published, work } = recordingFixture();
  const original = await recorder.sink({ type: 'stage.entered', stageId: 1, name: 'invalid', parentStageId: null, facts: move({ upload: new Blob(['source bytes']) }) }).catch(error => error as Error);
  expect(original).toBeInstanceOf(TypeError);
  if (!(original instanceof Error)) throw new Error('Expected the encoder failure');
  expect(original.message).toContain('Blob');
  await expect(recorder.sink({ type: 'stage.failed', stageId: 1, error: original })).rejects.toBe(original);
  await expect(recorder.finish(async () => metadata({ status: 500 }))).rejects.toBe(original);
  const outcomes = await Promise.allSettled(work);
  expect(outcomes).toEqual([{ status: 'rejected', reason: original }]);
  expect(records).toHaveLength(0);
  expect(published).toHaveLength(0);
});

test('storage rejection propagates the original error and prevents publication', async () => {
  const original = new Error('durable storage failed');
  let publications = 0;
  const { recorder } = recordingFixture({ write: async () => { throw original; }, publish: async () => { publications++; } });
  await expect(recorder.frame({ type: 'event', event: { text: 'recorded' } })).rejects.toBe(original);
  await expect(recorder.finish(async () => metadata())).rejects.toBe(original);
  expect(publications).toBe(0);
});

test('publication rejection preserves its original error after the complete record exists and omits live EOF', async () => {
  const original = new Error('broker failed');
  const entered = Promise.withResolvers<void>();
  const publication = Promise.withResolvers<void>();
  const { recorder, records: written, live } = recordingFixture({ publish: async () => { entered.resolve(); await publication.promise; } });
  await recorder.frame({ type: 'event', event: { text: 'recorded' } });
  const controller = new AbortController();
  const stream = (await live.get('recorded-run'))!;
  const reader = stream.read(0, controller.signal)[Symbol.asyncIterator]();
  expect((await reader.next()).done).toBe(false);
  const finishing = recorder.finish(async () => metadata());
  await entered.promise;
  expect(written).toHaveLength(1);
  publication.reject(original);
  await expect(finishing).rejects.toBe(original);
  let ended = false;
  const completion = reader.next().then(value => { ended = true; return value; });
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(ended).toBe(false);
  const cancelled = new Error('reader cancelled after interrupted recording');
  controller.abort(cancelled);
  await expect(completion).rejects.toBe(cancelled);
  expect(eventsOf(written[0]!).filter(event => event.type === 'stream.frame')).toHaveLength(1);
});

test('direct frames share a stream and separately opened streams retain distinct references', async () => {
  const { recorder, records: written } = recordingFixture();
  await recorder.frame({ type: 'event', event: 'first' });
  await recorder.frame({ type: 'event', event: 'second' });
  const independent = recorder.openStream();
  await independent.frame({ type: 'event', event: 'other' });
  await independent.end();
  await recorder.finish(async () => metadata());
  const events = eventsOf(written[0]!);
  expect(events.filter(event => event.type === 'stream.frame').map(event => event.streamId)).toEqual([1, 1, 2]);
  expect(events.filter(event => event.type === 'stream.end').map(event => event.streamId)).toEqual([2]);
});

test('clean live EOF waits for an entered metadata publication gate', async () => {
  const publishing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const { recorder, records, live } = recordingFixture({ publish: async () => { publishing.resolve(); await release.promise; } });
  await recorder.frame({ type: 'event', event: { text: 'published last' } });
  const stream = (await live.get('recorded-run'))!;
  const iterator = stream.read(0, new AbortController().signal)[Symbol.asyncIterator]();
  expect((await iterator.next()).done).toBe(false);
  const finishing = recorder.finish(async () => metadata());
  await publishing.promise;
  expect(records).toHaveLength(1);
  let ended = false;
  const completion = iterator.next().then(value => { ended = true; return value; });
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(ended).toBe(false);
  release.resolve();
  await finishing;
  expect((await completion).done).toBe(true);
});

test('a metadata factory failure aborts the actual durable reader with its original error', async () => {
  const original = new Error('metadata lookup failed', { cause: new Error('database unavailable') });
  const bodyFailure = Promise.withResolvers<unknown>();
  const { recorder, records, published, work } = recordingFixture({
    write: async run => {
      try { await new Response(run.events).arrayBuffer(); } catch (error) { bodyFailure.resolve(error); throw error; }
      await run.metadata;
    },
  });
  await recorder.frame({ type: 'event', event: { text: 'before metadata' } });
  await expect(recorder.finish(async () => { throw original; })).rejects.toBe(original);
  expect(await bodyFailure.promise).toBe(original);
  expect(await Promise.allSettled(work)).toEqual([{ status: 'rejected', reason: original }]);
  expect(records).toHaveLength(0);
  expect(published).toHaveLength(0);
});

test('large concurrent event batches retain shared identity and exact multibyte live bytes', async () => {
  const { recorder, records, live } = recordingFixture();
  const shared = move({ text: '中β'.repeat(40_000) });
  await Promise.all([
    recorder.sink({ type: 'stage.entered', stageId: 1, name: 'first', parentStageId: null, facts: move({ payload: shared }) }),
    recorder.sink({ type: 'stage.entered', stageId: 2, name: 'second', parentStageId: 1, facts: move({ payload: shared }) }),
  ]);
  await recorder.finish(async () => metadata());
  const chunks: Uint8Array[] = [];
  const stream = (await live.get('recorded-run'))!;
  for await (const bytes of stream.read(0, new AbortController().signal)) chunks.push(bytes);
  expect(chunks.length).toBeGreaterThan(2);
  expect(chunks.every(bytes => bytes.byteLength <= 64 * 1024)).toBe(true);
  const bytes = new Uint8Array(chunks.reduce((sum, value) => sum + value.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  expect(bytes).toEqual(records[0]!.events);
  const events = eventsOf(records[0]!);
  expect(events.filter(event => event.type === 'stage.entered').map(event => event.name)).toEqual(['first', 'second']);
  expect(events.filter(event => event.type === 'object')).toHaveLength(1);
});
