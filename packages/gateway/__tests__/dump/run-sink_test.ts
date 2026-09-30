import { expect, test, vi } from 'vitest';

import { installDumpStubs } from './test-fixtures.ts';
import { initDumpBroker, initDumpStore } from '../../src/dump/registry.ts';
import { openRunDump, runStreamId } from '../../src/dump/run-sink.ts';
import type { StoredDumpRecord } from '../../src/dump/types.ts';
import type { ApiKey } from '../../src/repo/types.ts';
import { flushBackground, trackBackground } from '../test-utils/background-tracker.ts';
import { testLogStreamStore } from '../test-utils/log-stream.ts';
import { compose, defineStage, defer, move, run, type DumpEvent, type Event } from '@floway-dev/pipeline';
import { getLogStreamStore, initLogStreamStore, LOG_STREAM_IDLE_MS } from '@floway-dev/platform';
import { assertEquals } from '@floway-dev/test-utils';

const apiKey = (dumpRetentionSeconds: number | null): ApiKey => ({
  id: 'key_run',
  userId: 1,
  name: 'Run key',
  key: 'raw-run-key',
  serverSecret: '11'.repeat(32),
  createdAt: '2026-01-01T00:00:00.000Z',
  upstreamIds: null,
  deletedAt: null,
  dumpRetentionSeconds,
  openaiResponsesRetentionSeconds: 0,
});

const requestBody = { bytes: new TextEncoder().encode('{"input":"hi"}'), streamError: null };

const turn = { method: 'POST', path: '/v1/embeddings', body: requestBody, headers: [] };

// Two stages, so the record has a shape to hold: one that hands down and one
// that answers.
interface Facts {
  'in.text': string;
  'out.result': string;
}

const answer = defineStage<Pick<Facts, 'in.text'>, Pick<Facts, 'out.result'>>({
  name: 'answer',
  return: { provides: ['out.result'] },
  execute: async facts => move({ ...facts, 'out.result': facts['in.text'].toUpperCase() }),
});

const shout = defineStage<Pick<Facts, 'in.text'>, Pick<Facts, 'in.text'>, Pick<Facts, 'out.result'>, Pick<Facts, 'out.result'>>({
  name: 'shout',
  through: {
    request: { needs: ['in.text'], consumes: [], provides: [] },
    response: { needs: ['out.result'], consumes: [], provides: [] },
  },
  execute: async (facts, next, use) => {
    await use.log.info('shouting', { length: facts['in.text'].length });
    return await next(move({ ...facts, 'in.text': `${facts['in.text']}!` }));
  },
});

const pipeline = compose<Pick<Facts, 'in.text'>, Pick<Facts, 'out.result'>>('shout-it', [shout, answer]);

const runRecordOf = (stored: { record: StoredDumpRecord } | undefined): StoredDumpRecord => {
  if (!stored) throw new Error('expected a stored dump record');
  return stored.record;
};

const ndjson = (record: StoredDumpRecord): string => new TextDecoder().decode(record.events);

const lines = (record: StoredDumpRecord): DumpEvent[] =>
  ndjson(record).split('\n').filter(Boolean).map(line => JSON.parse(line) as DumpEvent);

test('a run under a key with retention stores its whole event stream as NDJSON', async () => {
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);
  const dump = openRunDump(apiKey(3600), turn, trackBackground, false, { upstreamCallStartedAt: null, firstOutputTokenAt: null });
  if (dump === null) throw new Error('a key with retention must open a run dump');

  const { facts } = await run(pipeline, move({ 'in.text': 'hey' }), { dump: dump.sink });
  assertEquals(facts['out.result'], 'HEY!');
  dump.finalize(200, 12);
  await flushBackground();

  const record = runRecordOf(stubs.stored[0]);
  const events = lines(record);
  // Every stage is in the tree and the shape of the run is in the parent ids.
  assertEquals(
    events.filter(event => event.type === 'stage.entered').map(event => [event.name, event.parentStageId]),
    [['shout', null], ['answer', 1]],
  );
  // A stage's own log line is content about that stage, like the other five kinds.
  assertEquals(events.filter(event => event.type === 'stage.log').map(event => event.message), ['shouting']);
  // A `stage.leaved` that hands up exactly what its last child handed up carries
  // nothing and is not emitted, so `shout`'s exit goes and `answer`'s stays.
  assertEquals(events.filter(event => event.type === 'stage.leaved').map(event => event.stageId), [2]);
  // NDJSON: one event per line, appended in order, so the stored file and what a
  // live observer would be handed are the same bytes.
  assertEquals(ndjson(record).endsWith('\n'), true);
  assertEquals(ndjson(record).trimEnd().split('\n').length, events.length);

  assertEquals(record.meta.method, 'POST');
  assertEquals(record.meta.path, '/v1/embeddings');
  assertEquals(record.meta.status, 200);
  assertEquals(record.meta.requestBytes, requestBody.bytes.byteLength);
  assertEquals(record.meta.responseBytes, 12);
  assertEquals(stubs.published.map(entry => entry.meta.id), [record.meta.id]);
});

test('a key without retention opens no sink, so a run records and stores nothing', async () => {
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);
  const dump = openRunDump(apiKey(null), turn, trackBackground, false, { upstreamCallStartedAt: null, firstOutputTokenAt: null });
  assertEquals(dump, null);

  // The absence is the mechanism: with nothing to put in `services.dump` the
  // runner does none of the recording, rather than feeding a sink that throws
  // the result away.
  const emitted: Event[] = [];
  const services = dump === null ? {} : { dump: (event: Event) => { emitted.push(event); } };
  const { facts } = await run(pipeline, move({ 'in.text': 'hey' }), services);
  assertEquals(facts['out.result'], 'HEY!');
  await flushBackground();

  assertEquals(emitted, []);
  assertEquals(stubs.stored, []);
  assertEquals(stubs.published, []);
});

test('a run record carries the attribution the turn stamped on it', async () => {
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);
  const dump = openRunDump(apiKey(3600), turn, trackBackground, false, { upstreamCallStartedAt: null, firstOutputTokenAt: null });
  if (dump === null) throw new Error('a key with retention must open a run dump');

  dump.requestedModel('text-embedding-3-small');
  dump.failed(new Error('upstream   went\naway'));
  dump.finalize(null, 0);
  await flushBackground();

  const record = runRecordOf(stubs.stored[0]);
  assertEquals(record.meta.model, 'text-embedding-3-small');
  assertEquals(record.meta.status, null);
  assertEquals(record.meta.error, { kind: 'failed', reason: 'upstream went away' });
});

test('a run whose request never arrived intact records that as the turn\'s failure', async () => {
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);
  const dump = openRunDump(
    apiKey(3600),
    { ...turn, body: { bytes: new Uint8Array(), streamError: 'client aborted the upload' } },
    trackBackground,
    false,
    { upstreamCallStartedAt: null, firstOutputTokenAt: null },
  );
  if (dump === null) throw new Error('a key with retention must open a run dump');

  dump.finalize(400, 0);
  await flushBackground();

  assertEquals(runRecordOf(stubs.stored[0]).meta.error, { kind: 'failed', reason: 'client aborted the upload' });
});

test('finalizing on a response measures what the client reads and leaves it intact', async () => {
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);
  const dump = openRunDump(apiKey(3600), turn, trackBackground, false, { upstreamCallStartedAt: null, firstOutputTokenAt: null });
  if (dump === null) throw new Error('a key with retention must open a run dump');

  await run(pipeline, move({ 'in.text': 'hey' }), { dump: dump.sink });
  const answered = dump.finalize(new Response('data: one\n\ndata: two\n\n', {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  }));

  assertEquals(await answered.text(), 'data: one\n\ndata: two\n\n');
  await flushBackground();

  const record = runRecordOf(stubs.stored[0]);
  assertEquals(record.meta.responseBytes, 22);

});

test('a run reads the stable timing state at completion alongside its stage history', async () => {
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);
  const timing = { upstreamCallStartedAt: 100, firstOutputTokenAt: null as number | null };
  const dump = openRunDump(apiKey(3600), turn, trackBackground, true, timing);
  if (dump === null) throw new Error('a key with retention must open a run dump');
  await run(pipeline, move({ 'in.text': 'hey' }), { dump: dump.sink });
  timing.firstOutputTokenAt = 225;
  assertEquals(await dump.finalize(new Response('client')).text(), 'client');
  await flushBackground();
  const record = runRecordOf(stubs.stored[0]);
  assertEquals(record.meta.ttftMs, 125);
  assertEquals('capture' in record, false);
  assertEquals(lines(record).some(event => event.type === 'stage.entered'), true);
});

test('live bytes are visible before completion and equal the durable NDJSON artifact', async () => {
  initLogStreamStore(testLogStreamStore());
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);
  const dump = openRunDump(apiKey(3600), turn, trackBackground, false, { upstreamCallStartedAt: null, firstOutputTokenAt: null })!;
  await dump.sink({ type: 'stage.entered', stageId: 1, name: 'open', parentStageId: null, facts: move({ input: '中' }) });
  const live = await getLogStreamStore().get(runStreamId(apiKey(3600).id, dump.id));
  const reader = live!.read(0, new AbortController().signal)[Symbol.asyncIterator]();
  const first = await reader.next();
  expect(new TextDecoder().decode(first.value)).toContain('stage.entered');
  expect(stubs.stored).toHaveLength(0);
  dump.finalize(200, 0);
  await flushBackground();
  const rest: Uint8Array[] = [first.value!];
  for (;;) { const item = await reader.next(); if (item.done) break; rest.push(item.value); }
  expect(rest.map(bytes => new TextDecoder().decode(bytes)).join('')).toBe(ndjson(runRecordOf(stubs.stored[0])));
  expect(stubs.stored[0]!.record.meta.id).toBe(dump.id);
});

test('retries a lost live acknowledgement at the same offset without duplicating bytes', async () => {
  const underlying = testLogStreamStore();
  const positions: number[] = [];
  initLogStreamStore({
    get: id => underlying.get(id),
    open: async id => {
      const stream = await underlying.open(id);
      return {
        ...stream, append: async (offset, bytes) => {
          positions.push(offset);
          await stream.append(offset, bytes);
          if (positions.length === 1) throw new Error('lost acknowledgement');
        },
      };
    },
  });
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);
  const dump = openRunDump(apiKey(3600), turn, trackBackground, false, { upstreamCallStartedAt: null, firstOutputTokenAt: null })!;
  await dump.sink({ type: 'stage.entered', stageId: 1, name: 'retry', parentStageId: null, facts: move({ input: 'x' }) });
  dump.finalize(200, 0);
  await flushBackground();
  expect(positions).toEqual([0, 0]);
  const stream = await underlying.get(runStreamId(apiKey(3600).id, dump.id));
  const text: string[] = [];
  for await (const bytes of stream!.read(0, new AbortController().signal)) text.push(new TextDecoder().decode(bytes));
  expect(text.join('')).toBe(ndjson(runRecordOf(stubs.stored[0])));
});

test('a repeatedly failed live stream still stores the complete durable artifact', async () => {
  const original = new Error('live transport unavailable');
  const append = vi.fn(async () => { throw original; });
  initLogStreamStore({
    open: async () => ({ append, end: async () => {}, read: () => (async function* () {})() }),
    get: async () => null,
  });
  const reported = vi.spyOn(console, 'error').mockImplementation(() => {});
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);
  try {
    const dump = openRunDump(apiKey(3600), turn, trackBackground, false, { upstreamCallStartedAt: null, firstOutputTokenAt: null })!;
    const { drain } = await run(pipeline, move({ 'in.text': 'hello' }), { dump: dump.sink });
    dump.afterRun(drain);
    dump.finalize(200, 0);
    await flushBackground();
    expect(append).toHaveBeenCalledTimes(3);
    expect(lines(runRecordOf(stubs.stored[0])).filter(event => event.type === 'stage.entered')).toHaveLength(2);
    expect(reported.mock.calls.some(call => call[1] === original)).toBe(true);
  } finally { reported.mockRestore(); initLogStreamStore(testLogStreamStore()); }
});

test('durable backpressure blocks a producer before it can enqueue another event', async () => {
  initLogStreamStore(testLogStreamStore());
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);
  const gate = Promise.withResolvers<void>();
  initDumpStore({
    ...stubs.store, putRun: async (keyId, writing) => {
      await gate.promise;
      await stubs.store.putRun(keyId, writing);
    },
  });
  const dump = openRunDump(apiKey(3600), turn, trackBackground, false, { upstreamCallStartedAt: null, firstOutputTokenAt: null })!;
  let wrote = false;
  const write = dump.sink({ type: 'stage.entered', stageId: 1, name: 'blocked', parentStageId: null, facts: move({}) }).then(() => { wrote = true; });
  await Promise.resolve(); await Promise.resolve();
  expect(wrote).toBe(false);
  gate.resolve();
  await write;
  dump.finalize(200, 0);
  await flushBackground();
  expect(wrote).toBe(true);
});

test('closing waits for deferred outcomes and persists their settlement event', async () => {
  initLogStreamStore(testLogStreamStore());
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);
  const result = Promise.withResolvers<string>();
  const deferred = defer(result.promise);
  const terminal = defineStage<Record<string, never>, { pending: typeof deferred }>({
    name: 'pending', return: { provides: ['pending'] }, execute: async () => move({ pending: deferred }),
  });
  const dump = openRunDump(apiKey(3600), turn, trackBackground, false, { upstreamCallStartedAt: null, firstOutputTokenAt: null })!;
  const { drain } = await run(compose('deferred', [terminal]), move({}), { dump: dump.sink });
  dump.afterRun(drain);
  dump.finalize(200, 0);
  await Promise.resolve();
  expect(stubs.stored).toHaveLength(0);
  result.resolve('late value');
  await flushBackground();
  expect(lines(runRecordOf(stubs.stored[0])).some(event => event.type === 'deferred.settled')).toBe(true);
  expect(ndjson(runRecordOf(stubs.stored[0]))).toContain('late value');
});

test('heartbeat append waits for the in-flight event and uses its resulting byte offset', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const underlying = testLogStreamStore();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const positions: { offset: number; length: number }[] = [];
  initLogStreamStore({
    get: id => underlying.get(id),
    open: async id => {
      const stream = await underlying.open(id);
      return {
        ...stream, append: async (offset, bytes) => {
          positions.push({ offset, length: bytes.byteLength });
          if (positions.length === 1) { entered.resolve(); await release.promise; }
          await stream.append(offset, bytes);
        },
      };
    },
  });
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);
  try {
    const dump = openRunDump(apiKey(3600), turn, trackBackground, false, { upstreamCallStartedAt: null, firstOutputTokenAt: null })!;
    const event = dump.sink({ type: 'stage.entered', stageId: 1, name: 'slow append', parentStageId: null, facts: move({}) });
    await entered.promise;
    await vi.advanceTimersByTimeAsync(LOG_STREAM_IDLE_MS / 2);
    expect(positions).toHaveLength(1);
    release.resolve();
    await event;
    dump.finalize(200, 0);
    await flushBackground();
    expect(positions).toEqual([{ offset: 0, length: positions[0]!.length }, { offset: positions[0]!.length, length: 0 }]);
    expect(stubs.stored).toHaveLength(1);
  } finally { release.resolve(); vi.useRealTimers(); initLogStreamStore(testLogStreamStore()); }
});
