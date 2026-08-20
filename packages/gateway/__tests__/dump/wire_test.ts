import { expect, test } from 'vitest';

import type { StoredDumpRecord } from '../../src/dump/types.ts';
import { dumpRecordToWire } from '../../src/dump/wire.ts';
import { assertEquals } from '@floway-dev/test-utils';

const stored = (events: Uint8Array): StoredDumpRecord => ({
  meta: {
    id: 'rec',
    startedAt: 0,
    completedAt: 1,
    method: 'POST',
    path: '/v1/x',
    status: 200,
    upstream: null,
    model: null,
    inputTokens: null,
    outputTokens: null,
    requestBytes: 0,
    responseBytes: 0,
    durationMs: 1,
    error: null,
  },
  events,
});

// A record crosses to the wire as the stored bytes decoded, because a line of NDJSON is one
// event and one SSE `data:` payload — what the dashboard reads here is what a live observer
// will read frame by frame.
test('dumpRecordToWire hands a record its NDJSON verbatim', () => {
  const ndjson = '{"type":"stage.entered","stageId":1,"name":"serve","parentStageId":null}\n'
    + '{"type":"stage.leaved","stageId":1,"facts":{"response.http.status":200}}\n';
  const wire = dumpRecordToWire(stored(new TextEncoder().encode(ndjson)));

  assertEquals(wire.events, ndjson);
  assertEquals(wire.meta.id, 'rec');
});

// The gateway wrote those bytes itself, so bytes that are not UTF-8 mean a corrupted record and
// the reader says so rather than serving mojibake.
test('dumpRecordToWire refuses a stream that is not UTF-8', () => {
  expect(() => dumpRecordToWire(stored(new Uint8Array([0xFF, 0xFE, 0xFD])))).toThrow();
});
