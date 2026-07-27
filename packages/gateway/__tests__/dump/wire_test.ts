import { test } from 'vitest';

import type { StoredDumpRecord } from '../../src/dump/types.ts';
import { dumpRecordToWire } from '../../src/dump/wire.ts';
import { assertEquals } from '@floway-dev/test-utils';

const baseStored = (overrides: Partial<StoredDumpRecord> = {}): StoredDumpRecord => ({
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

// A textual request content-type with valid UTF-8 bytes serializes as utf8 on
// the wire — the dashboard reads `data` directly as a string.
test('dumpRecordToWire encodes a textual request body as utf8', () => {
  const wire = dumpRecordToWire(baseStored({
    request: {
      method: 'POST',
      path: '/v1/messages',
      headers: [['content-type', 'application/json']],
      body: new TextEncoder().encode('{"k":"v"}'),
    },
  }));
  assertEquals(wire.request.body.encoding, 'utf8');
  assertEquals(wire.request.body.data, '{"k":"v"}');
});

// A binary content-type round-trips through base64 so JSON serialization
// preserves every byte; the dashboard decodes base64 client-side.
test('dumpRecordToWire encodes a binary response body as base64', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4E, 0x47]); // PNG magic
  const wire = dumpRecordToWire(baseStored({
    response: {
      status: 200,
      headers: [['content-type', 'image/png']],
      body: { type: 'bytes', body: png },
    },
  }));
  if (wire.response.body.type !== 'bytes') throw new Error('expected bytes');
  assertEquals(wire.response.body.body.encoding, 'base64');
  // Decoding the base64 back to bytes must reproduce the original sequence.
  const binary = atob(wire.response.body.body.data);
  assertEquals(Array.from(binary, c => c.charCodeAt(0)), [0x89, 0x50, 0x4E, 0x47]);
});

// A content-type that claims to be text but carries bytes that do not decode
// as UTF-8 falls through to base64 so the wire never silently corrupts.
test('dumpRecordToWire falls back to base64 when textual content-type carries non-UTF-8 bytes', () => {
  const bytes = new Uint8Array([0xFF, 0xFE, 0xFD]);
  const wire = dumpRecordToWire(baseStored({
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

// `stream` and `none` response bodies pass through wire serialization
// unchanged because they carry no raw bytes.
test('dumpRecordToWire passes stream + none response bodies through', () => {
  const streamWire = dumpRecordToWire(baseStored({
    response: { status: 200, headers: [], body: { type: 'stream', events: [] } },
  }));
  assertEquals(streamWire.response.body.type, 'stream');

  const noneWire = dumpRecordToWire(baseStored({
    response: { status: null, headers: [], body: { type: 'none' } },
  }));
  assertEquals(noneWire.response.body.type, 'none');
});
