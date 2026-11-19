import { expect, test } from 'vitest';

import { fakeMeta } from './test-fixtures.ts';
import { dumpCodec } from '../../src/dump/codec.ts';
import { decodeDumpHeaders, decodePersistedDumpMetadata, encodeDumpHeaders } from '../../src/dump/storage-codec.ts';

test('dump storage headers preserve duplicate pairs and their order', () => {
  const headers: Array<[string, string]> = [
    ['set-cookie', 'a=1'],
    ['x-empty', ''],
    ['set-cookie', 'b=2'],
  ];

  expect(decodeDumpHeaders(encodeDumpHeaders(headers, 'test headers'), 'test headers')).toEqual(headers);
});

test('dump broker frames reject valid JSON with malformed metadata', () => {
  const frame = {
    event: 'appended',
    data: { ...fakeMeta(), status: '200' },
  };

  expect(() => dumpCodec.decode(JSON.stringify(frame)))
    .toThrow();
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
