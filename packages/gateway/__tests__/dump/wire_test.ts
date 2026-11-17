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

test('dumpRecordToWire recognizes structured textual suffixes without accepting near matches', () => {
  const structured = dumpRecordToWire(baseStored({
    request: {
      method: 'POST',
      path: '/v1/x',
      headers: [['content-type', 'Application/Problem+JSON; charset=utf-8']],
      body: new TextEncoder().encode('{"error":"bad"}'),
    },
  }));
  assertEquals(structured.request.body.encoding, 'utf8');

  const nearMatch = dumpRecordToWire(baseStored({
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

test('dumpRecordToWire redacts upstream credentials from exchange and legacy headers', () => {
  const wire = dumpRecordToWire(baseStored({
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
