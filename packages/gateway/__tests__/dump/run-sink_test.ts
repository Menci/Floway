import { test } from 'vitest';

import { installDumpStubs } from './test-fixtures.ts';
import { initDumpBroker, initDumpStore } from '../../src/dump/registry.ts';
import { openRunDump } from '../../src/dump/run-sink.ts';
import type { StoredDumpRecord, StoredDumpRunRecord } from '../../src/dump/types.ts';
import type { ApiKey } from '../../src/repo/types.ts';
import { flushBackground, trackBackground } from '../test-utils/background-tracker.ts';
import { compose, defineStage, move, run, type DumpEvent, type Event } from '@floway-dev/pipeline';
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
  responsesRetentionSeconds: 0,
});

const requestBody = { bytes: new TextEncoder().encode('{"input":"hi"}'), streamError: null };

const turn = { method: 'POST', path: '/v1/embeddings', body: requestBody };

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
    use.log.info('shouting', { length: facts['in.text'].length });
    return await next(move({ ...facts, 'in.text': `${facts['in.text']}!` }));
  },
});

const pipeline = compose<Pick<Facts, 'in.text'>, Pick<Facts, 'out.result'>>('shout-it', [shout, answer]);

const runRecordOf = (stored: { record: StoredDumpRecord } | undefined): StoredDumpRunRecord => {
  if (!stored) throw new Error('expected a stored dump record');
  if (stored.record.shape !== 'run') throw new Error(`expected the run shape, got ${stored.record.shape}`);
  return stored.record;
};

const ndjson = (record: StoredDumpRunRecord): string => new TextDecoder().decode(record.events);

const lines = (record: StoredDumpRunRecord): DumpEvent[] =>
  ndjson(record).split('\n').filter(Boolean).map(line => JSON.parse(line) as DumpEvent);

test('a run under a key with retention stores its whole event stream as NDJSON', async () => {
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);
  const dump = openRunDump(apiKey(3600), turn, trackBackground);
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
  const dump = openRunDump(apiKey(null), turn, trackBackground);
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
  const dump = openRunDump(apiKey(3600), turn, trackBackground);
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
  );
  if (dump === null) throw new Error('a key with retention must open a run dump');

  dump.finalize(400, 0);
  await flushBackground();

  assertEquals(runRecordOf(stubs.stored[0]).meta.error, { kind: 'failed', reason: 'client aborted the upload' });
});

test('finalizing on a response measures what the client reads and leaves it intact', async () => {
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);
  const dump = openRunDump(apiKey(3600), turn, trackBackground);
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
