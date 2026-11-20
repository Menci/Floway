import { expect, test } from 'vitest';

import type { DumpEdgeRecord, StoredDumpEdgeRecord } from '../../src/dump/types.ts';
import { dumpRecordToWire } from '../../src/dump/wire.ts';
import { assertEquals } from '@floway-dev/test-utils';

const baseStored = (overrides: Partial<StoredDumpEdgeRecord> = {}): StoredDumpEdgeRecord => ({
  shape: 'edge',
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
  request: { method: 'POST', path: '/v1/x', headers: [], body: new Uint8Array() },
  response: { status: 200, headers: [], body: { type: 'none' } },
  ...overrides,
});

const edgeWire = (record: StoredDumpEdgeRecord): DumpEdgeRecord => {
  const wire = dumpRecordToWire(record);
  if (wire.shape !== 'edge') throw new Error('expected the edge shape');
  return wire;
};

test('dumpRecordToWire recognizes structured textual suffixes without accepting near matches', () => {
  const structured = edgeWire(baseStored({
    request: {
      method: 'POST',
      path: '/v1/x',
      headers: [['content-type', 'Application/Problem+JSON; charset=utf-8']],
      body: new TextEncoder().encode('{"error":"bad"}'),
    },
  }));
  assertEquals(structured.request.body.encoding, 'utf8');

  const nearMatch = edgeWire(baseStored({
    request: {
      method: 'POST',
      path: '/v1/x',
      headers: [['content-type', 'application/jsonish']],
      body: new TextEncoder().encode('{"not":"json"}'),
    },
  }));
  assertEquals(nearMatch.request.body.encoding, 'base64');
});

// A content-type that claims to be text but carries bytes that do not decode
// as UTF-8 falls through to base64 so the wire never silently corrupts.
test('dumpRecordToWire falls back to base64 when textual content-type carries non-UTF-8 bytes', () => {
  const bytes = new Uint8Array([0xFF, 0xFE, 0xFD]);
  const wire = edgeWire(baseStored({
    request: {
      method: 'POST',
      path: '/v1/x',
      headers: [['content-type', 'text/plain']],
      body: bytes,
    },
  }));
  assertEquals(wire.request.body.encoding, 'base64');
  const binary = atob(wire.request.body.data);
  assertEquals(Array.from(binary, c => c.charCodeAt(0)), [0xFF, 0xFE, 0xFD]);
});

// A run record crosses to the wire as the stored bytes decoded, because a line
// of NDJSON is one event and one SSE `data:` payload — what the dashboard reads
// here is what a live observer will read frame by frame.
test('dumpRecordToWire hands a run record its NDJSON verbatim', () => {
  const ndjson = '{"type":"stage.entered","stageId":1,"name":"serve","parentStageId":null}\n'
    + '{"type":"stage.leaved","stageId":1,"facts":{"response.http.status":200}}\n';
  const wire = dumpRecordToWire({
    shape: 'run',
    meta: baseStored().meta,
    events: new TextEncoder().encode(ndjson),
  });
  if (wire.shape !== 'run') throw new Error('expected the run shape');
  assertEquals(wire.events, ndjson);
  assertEquals(wire.meta.id, 'rec');
});

// The gateway wrote those bytes itself, so bytes that are not UTF-8 mean a
// corrupted record and the reader says so rather than serving mojibake.
test('dumpRecordToWire refuses a run stream that is not UTF-8', () => {
  expect(() => dumpRecordToWire({
    shape: 'run',
    meta: baseStored().meta,
    events: new Uint8Array([0xFF, 0xFE, 0xFD]),
  })).toThrow();
});

test('dumpRecordToWire redacts upstream credentials from exchange and legacy headers', () => {
  const wire = edgeWire(baseStored({
    capture: {
      exchanges: [{
        upstreamId: 'u',
        request: {
          url: 'https://upstream.test',
          method: 'POST',
          headers: [['authorization', 'Bearer secret'], ['content-type', 'application/json']],
          body: { encoding: 'utf8', data: '{}' },
        },
        response: { status: 200, headers: [['x-api-key', 'secret'], ['x-request-id', 'trace']], body: { encoding: 'utf8', data: '{}' }, complete: true, error: null },
        error: null,
      }],
      response: { body: { encoding: 'utf8', data: '{}' }, complete: true, error: null },
    },
    response: {
      status: 200,
      headers: [],
      body: { type: 'none' },
      upstream: { status: 200, headers: [['set-cookie', 'secret']], body: { type: 'none' } },
    },
  }));

  assertEquals(wire.capture?.exchanges[0]?.request.headers, [['authorization', '[redacted]'], ['content-type', 'application/json']]);
  assertEquals(wire.capture?.exchanges[0]?.response?.headers, [['x-api-key', '[redacted]'], ['x-request-id', 'trace']]);
  assertEquals(wire.response.upstream?.headers, [['set-cookie', '[redacted]']]);
});
