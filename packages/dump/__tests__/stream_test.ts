import { expect, test } from 'vitest';

import { eventsOf, metadata } from './fixtures.ts';
import { createRunRecorder, recordStream, streamReferenceOf, type StoredDumpRecord, type StreamRecorder } from '../src/index.ts';
import { isStreamFact, streamFact } from '@floway-dev/pipeline';
import type { ProtocolFrame } from '@floway-dev/protocols/common';

const frames = [
  { type: 'event', event: { text: 'first 中' } },
  { type: 'event', event: { text: 'second' } },
] as const;

const fixture = () => {
  const records: StoredDumpRecord[] = [];
  const recorder = createRunRecorder({ write: async record => { records.push(record); }, publish: async () => {} });
  return { recorder, records };
};

test('natural source EOF records the same values and its completion marker', async () => {
  const { recorder, records } = fixture();
  const source = (async function* () { yield* frames; })();
  const recorded = recordStream(source, recorder);
  const values: unknown[] = [];
  for await (const value of recorded) values.push(value);
  expect(values[0]).toBe(frames[0]);
  expect(values[1]).toBe(frames[1]);
  expect(isStreamFact(recorded)).toBe(true);
  expect(isStreamFact(streamReferenceOf(recorded))).toBe(true);
  await recorder.finish(metadata());
  const events = eventsOf(records[0]!);
  expect(events.filter(event => event.type === 'stream.frame')).toHaveLength(2);
  expect(events.filter(event => event.type === 'stream.end').map(event => event.streamId)).toEqual([1]);
});

test('an early return closes the actual source and leaves its recording incomplete', async () => {
  const { recorder, records } = fixture();
  let closed = false;
  const source = (async function* () { try { yield* frames; } finally { closed = true; } })();
  const iterator = recordStream(source, recorder)[Symbol.asyncIterator]();
  expect((await iterator.next()).value).toBe(frames[0]);
  await iterator.return?.();
  expect(closed).toBe(true);
  await recorder.finish(metadata());
  const events = eventsOf(records[0]!);
  expect(events.filter(event => event.type === 'stream.frame')).toHaveLength(1);
  expect(events.some(event => event.type === 'stream.end')).toBe(false);
});

test('a source failure preserves its original error and omits clean completion', async () => {
  const { recorder, records } = fixture();
  const original = new Error('source failed');
  let closed = false;
  const source = (async function* () {
    try { yield frames[0]; throw original; } finally { closed = true; }
  })();
  const iterator = recordStream(source, recorder)[Symbol.asyncIterator]();
  expect((await iterator.next()).value).toBe(frames[0]);
  await expect(iterator.next()).rejects.toBe(original);
  expect(closed).toBe(true);
  await recorder.finish(metadata());
  const events = eventsOf(records[0]!);
  expect(events.filter(event => event.type === 'stream.frame')).toHaveLength(1);
  expect(events.some(event => event.type === 'stream.end')).toBe(false);
});

test('projection can skip recording a value while forwarding every source value untouched', async () => {
  const { recorder, records } = fixture();
  const skipped = { kind: 'heartbeat' } as const;
  const content = { kind: 'text', text: 'recorded' } as const;
  const source = (async function* () { yield skipped; yield content; })();
  const values: unknown[] = [];
  const projected: ProtocolFrame<unknown> = { type: 'event', event: content };
  for await (const value of recordStream(source, recorder, value => value.kind === 'heartbeat' ? null : projected)) values.push(value);
  expect(values[0]).toBe(skipped);
  expect(values[1]).toBe(content);
  await recorder.finish(metadata());
  const events = eventsOf(records[0]!);
  expect(events.filter(event => event.type === 'stream.frame')).toHaveLength(1);
  expect(events.filter(event => event.type === 'stream.end')).toHaveLength(1);
});

test('no recorder returns the source identity and does not invoke projection', () => {
  const source = (async function* () { yield frames[0]; })();
  const recorded = recordStream(source, null, () => { throw new Error('Projection must not run'); });
  expect(recorded).toBe(source);
  expect(streamReferenceOf(source)).toEqual({});
});

test('a source value is not yielded until its asynchronous frame write completes', async () => {
  const entered = Promise.withResolvers<void>();
  const stored = Promise.withResolvers<void>();
  let closed = false;
  let yielded = false;
  const recorder: StreamRecorder = {
    openStream: () => ({
      fact: streamFact(1),
      frame: async frame => { expect(frame).toBe(frames[0]); entered.resolve(); await stored.promise; },
      end: () => { throw new Error('Early return must not end the recording'); },
    }),
  };
  const source = (async function* () { try { yield frames[0]; } finally { closed = true; } })();
  const iterator = recordStream(source, recorder)[Symbol.asyncIterator]();
  const first = iterator.next().then(value => { yielded = true; return value; });
  await entered.promise;
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(yielded).toBe(false);
  stored.resolve();
  expect((await first).value).toBe(frames[0]);
  await iterator.return?.();
  expect(closed).toBe(true);
});

test('clean iterator completion waits for the asynchronous recording end', async () => {
  const entered = Promise.withResolvers<void>();
  const stored = Promise.withResolvers<void>();
  let completed = false;
  const recorder: StreamRecorder = {
    openStream: () => ({
      fact: streamFact(1),
      frame: () => { throw new Error('The empty source has no frames'); },
      end: async () => { entered.resolve(); await stored.promise; },
    }),
  };
  const source = (async function* (): AsyncGenerator<ProtocolFrame<unknown>> {})();
  const iterator = recordStream(source, recorder)[Symbol.asyncIterator]();
  const completion = iterator.next().then(value => { completed = true; return value; });
  await entered.promise;
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(completed).toBe(false);
  stored.resolve();
  expect((await completion).done).toBe(true);
});

test('recording failure closes the actual source and preserves the original exception', async () => {
  const original = new Error('frame write failed');
  let closed = false;
  let ended = false;
  const recorder: StreamRecorder = {
    openStream: () => ({ fact: streamFact(1), frame: async () => { throw original; }, end: () => { ended = true; } }),
  };
  const source = (async function* () { try { yield* frames; } finally { closed = true; } })();
  const iterator = recordStream(source, recorder)[Symbol.asyncIterator]();
  await expect(iterator.next()).rejects.toBe(original);
  expect(closed).toBe(true);
  expect(ended).toBe(false);
});
