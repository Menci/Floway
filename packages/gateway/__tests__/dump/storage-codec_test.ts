import { expect, test } from 'vitest';

import { fakeMeta } from './test-fixtures.ts';
import {
  decodePersistedDumpMetadata,
  encodePersistedDumpMetadata,
} from '../../src/dump/storage-codec.ts';

// `targetApi` is the target protocol of a translated turn. It round-trips
// through persisted metadata, and old `meta_json` written before the field
// existed (or native turns with no target) has no target wire to display.
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

test('persisted metadata round-trips ttftMs', () => {
  const meta = fakeMeta({ ttftMs: 142 });
  const decoded = decodePersistedDumpMetadata(
    encodePersistedDumpMetadata(meta, 'test ttftMs'),
    'test ttftMs',
  );
  expect(decoded.ttftMs).toBe(142);
});

test('persisted metadata round-trips null ttftMs', () => {
  const meta = fakeMeta({ ttftMs: null });
  const decoded = decodePersistedDumpMetadata(
    encodePersistedDumpMetadata(meta, 'test null ttftMs'),
    'test null ttftMs',
  );
  expect(decoded.ttftMs).toBeNull();
});

test('persisted metadata parses old JSON without ttftMs as undefined (nullish)', () => {
  const oldJson = JSON.stringify({
    id: 'rec-no-ttft',
    startedAt: 0,
    completedAt: 1,
    method: 'POST',
    path: '/v1/chat/completions',
    status: 200,
    model: null,
    inputTokens: null,
    outputTokens: null,
    requestBytes: 0,
    responseBytes: 0,
    durationMs: 1,
    error: null,
  });
  const decoded = decodePersistedDumpMetadata(oldJson, 'test old metadata without ttft');
  expect(decoded.ttftMs == null).toBe(true);
});
