import { expect, test } from 'vitest';

import { fakeMeta } from './test-fixtures.ts';
import { dumpCodec } from '../../src/dump/codec.ts';
import { decodePersistedDumpMetadata, encodePersistedDumpMetadata } from '../../src/dump/storage-codec.ts';

test('dump broker codec round-trips started and appended frames', () => {
  const started = {
    event: 'started' as const,
    data: { id: 'rec', startedAt: 0, method: 'POST', path: '/v1/x', model: null, requestBytes: 2 },
  };
  const appended = { event: 'appended' as const, data: fakeMeta() };
  expect(dumpCodec.decode(dumpCodec.encode(started))).toEqual(started);
  expect(dumpCodec.decode(dumpCodec.encode(appended))).toEqual(appended);
});

test('dump broker frames reject valid JSON with malformed metadata', () => {
  expect(() => dumpCodec.decode(JSON.stringify({ event: 'appended', data: { ...fakeMeta(), status: '200' } })))
    .toThrow();
});

test('persisted metadata round-trips truncation fields and parses old JSON without targetApi', () => {
  const meta = { ...fakeMeta(), truncated: true, droppedEvents: 3 };
  expect(decodePersistedDumpMetadata(encodePersistedDumpMetadata(meta, 'test metadata'), 'test metadata'))
    .toEqual({ ...meta, upstream: undefined });

  const oldJson = JSON.stringify({
    id: 'rec', startedAt: 0, completedAt: 1, method: 'POST', path: '/v1/messages', status: 200,
    model: null, inputTokens: null, outputTokens: null, requestBytes: 0, responseBytes: 0,
    durationMs: 1, error: null,
  });
  expect(decodePersistedDumpMetadata(oldJson, 'test old metadata').targetApi == null).toBe(true);
});
