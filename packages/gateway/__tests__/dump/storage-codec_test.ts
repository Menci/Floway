import { expect, test } from 'vitest';

import { fakeMeta } from './test-fixtures.ts';
import { dumpCodec } from '../../src/dump/codec.ts';
import {
  decodeDumpHeaders,
  decodePersistedDumpMetadata,
  encodeDumpHeaders,
  encodePersistedDumpMetadata,
} from '../../src/dump/storage-codec.ts';

test('dump storage headers preserve duplicate pairs and their order', () => {
  const headers: Array<[string, string]> = [
    ['set-cookie', 'a=1'],
    ['x-empty', ''],
    ['set-cookie', 'b=2'],
  ];

  expect(decodeDumpHeaders(encodeDumpHeaders(headers, 'test headers'), 'test headers')).toEqual(headers);
});

test('dump broker frames round-trip metadata through the shared schema', () => {
  const metadata = fakeMeta({
    upstream: { id: 'upstream-a', name: 'A', kind: 'custom', hue: 42 },
    error: { kind: 'failed', reason: 'connection closed' },
  });

  expect(dumpCodec.decode(dumpCodec.encode(metadata))).toEqual(metadata);
});

test('dump broker frames reject valid JSON with malformed metadata', () => {
  const frame = {
    event: 'appended',
    data: { ...fakeMeta(), status: '200' },
  };

  expect(() => dumpCodec.decode(JSON.stringify(frame)))
    .toThrow(/Invalid dump broker frame.*status/su);
});

// `targetApi` is the target protocol of a translated turn. It round-trips
// through persisted metadata, and old `meta_json` written before the field
// existed (or native turns with no target) parses to null — the dashboard
// renders no upstream tab for those records.
test('persisted metadata round-trips targetApi', () => {
  const meta = fakeMeta({ targetApi: 'openaiResponses' });
  const decoded = decodePersistedDumpMetadata(
    encodePersistedDumpMetadata(meta, 'test targetApi'),
    'test targetApi',
  );
  expect(decoded.targetApi).toBe('openaiResponses');
});

test('persisted metadata parses old JSON without targetApi as null', () => {
  const oldJson = JSON.stringify({
    id: 'rec',
    startedAt: 0,
    completedAt: 1,
    method: 'POST',
    path: '/v1/messages',
    status: 200,
    model: null,
    inputTokens: null,
    outputTokens: null,
    requestBytes: 0,
    responseBytes: 0,
    durationMs: 1,
    error: null,
  });
  const decoded = decodePersistedDumpMetadata(oldJson, 'test old metadata');
  expect(decoded.targetApi == null).toBe(true);
});

test('persisted metadata parses absent targetApi as undefined (nullish)', () => {
  // Same old JSON as above; .nullish() yields undefined for a missing key,
  // which the dashboard treats as "no upstream view" identically to null.
  const oldJson = JSON.stringify({
    id: 'rec2',
    startedAt: 0,
    completedAt: 1,
    method: 'POST',
    path: '/v1/messages',
    status: 200,
    model: null,
    inputTokens: null,
    outputTokens: null,
    requestBytes: 0,
    responseBytes: 0,
    durationMs: 1,
    error: null,
  });
  const decoded = decodePersistedDumpMetadata(oldJson, 'test old metadata 2');
  // nullish means null OR undefined both acceptable; assert it is one of them.
  expect(decoded.targetApi == null).toBe(true);
});
