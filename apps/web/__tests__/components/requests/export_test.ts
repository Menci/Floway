import { describe, expect, it } from 'vitest';

import { exportRecords, type ExportableDumpRecord } from '../../../src/components/requests/export';
import { redactHeaderValue } from '../../../src/components/requests/header-redact';
import type { DumpMetadata } from '@floway-dev/gateway/browser';

const SECRET = 'Bearer client-secret-token-1234567890abcd';
const MASK = redactHeaderValue(SECRET);

const meta = (id: string): DumpMetadata => ({
  id,
  method: 'POST',
  path: '/v1/chat/completions',
  startedAt: 0,
  completedAt: 1000,
  status: 200,
  upstream: null,
  model: 'm',
  inputTokens: null,
  outputTokens: null,
  requestBytes: 0,
  responseBytes: 0,
  durationMs: 1000,
  error: null,
});

const record = (id: string): ExportableDumpRecord => ({
  meta: meta(id),
  events: [
    { k: 'run', seq: 1, tMs: 0, runId: id, pipelineName: 'test', startedAt: 0 },
    {
      k: 'enter', seq: 2, tMs: 1, stageId: 1, parentStageId: null, edgeKind: 'root', name: 'edge', tap: 'downstream',
      facts: {
        'request.http': {
          method: 'POST',
          url: 'https://example.test/v1/chat/completions',
          headers: [['authorization', SECRET], ['content-type', 'application/json']],
        },
      },
    },
    {
      k: 'leave', seq: 3, tMs: 2, stageId: 1,
      outcome: { status: 200, headers: [['set-cookie', SECRET]] },
    },
  ],
});

const redactedRecord = (id: string): ExportableDumpRecord => {
  const source = record(id);
  return {
    meta: source.meta,
    events: [
      source.events[0]!,
      {
        k: 'enter', seq: 2, tMs: 1, stageId: 1, parentStageId: null, edgeKind: 'root', name: 'edge', tap: 'downstream',
        facts: { 'request.http': { method: 'POST', url: 'https://example.test/v1/chat/completions', headers: [['authorization', MASK], ['content-type', 'application/json']] } },
      },
      {
        k: 'leave', seq: 3, tMs: 2, stageId: 1,
        outcome: { status: 200, headers: [['set-cookie', MASK]] },
      },
    ],
  };
};

describe('request export', () => {
  it('writes a version 2 combined dump with defensive header redaction', async () => {
    const parsed = JSON.parse(await exportRecords([record('one')], false).text()) as {
      format: string;
      version: number;
      records: ExportableDumpRecord[];
    };
    expect(parsed.format).toBe('floway-request-dump');
    expect(parsed.version).toBe(2);
    expect(parsed.records).toEqual([redactedRecord('one')]);
  });

  it('writes independent UTF-8 JSON members with valid tar sizes and checksums', async () => {
    const records = [record('one'), record('two')];
    const bytes = new Uint8Array(await exportRecords(records, true).arrayBuffer());
    const decoder = new TextDecoder();
    let offset = 0;
    for (const expected of records) {
      const header = bytes.slice(offset, offset + 512);
      const field = (start: number, end: number) => decoder.decode(header.slice(start, end)).replace(/\0.*$/s, '').trim();
      expect(field(0, 100)).toBe(`${expected.meta.id}.json`);
      const checksum = parseInt(field(148, 156), 8);
      header.fill(32, 148, 156);
      expect(header.reduce((sum, byte) => sum + byte, 0)).toBe(checksum);
      const size = parseInt(field(124, 136), 8);
      const member = JSON.parse(decoder.decode(bytes.slice(offset + 512, offset + 512 + size))) as { format: string; version: number; record: ExportableDumpRecord };
      expect(member).toMatchObject({ format: 'floway-request-dump', version: 2 });
      expect(member.record).toEqual(redactedRecord(expected.meta.id));
      offset += 512 + Math.ceil(size / 512) * 512;
    }
    expect(bytes.slice(offset)).toEqual(new Uint8Array(1024));
  });
});
