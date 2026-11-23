import { describe, expect, it } from 'vitest';

import { exportRecords, type ExportableDumpRecord } from '../../../src/components/requests/export';
import { createDumpDecoder } from '@floway-dev/dump/browser';
import type { DumpMetadata } from '@floway-dev/gateway/browser';

const storedSecret = { $secret: { length: 42, hash: '0123456789abcdef', redacted: 'Bear****abcd' } };

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
    { k: 'run', seq: 1, tMs: 0, runId: id, pipeline: 'test', startedAt: 0 },
    { k: 'obj', from: 1, nodes: [['authorization', storedSecret], { 'request.http': { headers: [{ $: 1 }] } }] },
    {
      k: 'enter', seq: 2, tMs: 1, stageId: 1, parentStageId: null, edge: 'root', name: 'edge', pipeline: 'test',
      facts: { $: 2 },
    },
    { k: 'leave', seq: 3, tMs: 2, stageId: 1, facts: { $: 2 } },
    { k: 'closed', seq: 4, tMs: 3, stageId: 1, ok: true },
    { k: 'truncated', seq: 5, tMs: 3, reason: 'size-limit' },
    { k: 'done', seq: 6, tMs: 3, ok: true },
  ],
});

describe('request export', () => {
  it('writes a version 3 combined dump with object identity, stored secrets, and terminal events intact', async () => {
    const parsed = JSON.parse(await exportRecords([record('one')], false).text()) as {
      format: string;
      version: number;
      records: ExportableDumpRecord[];
    };
    expect(parsed.format).toBe('floway-request-dump');
    expect(parsed.version).toBe(3);
    expect(parsed.records).toEqual([record('one')]);
    const model = createDumpDecoder().pushEvents(parsed.records[0]!.events);
    const stage = model.stages.get(1)!;
    expect(stage.facts).toBe(stage.responseFacts);
    expect(stage.facts['request.http']).toEqual({ headers: [['authorization', storedSecret]] });
    expect(model.run).toMatchObject({ done: { ok: true }, truncated: { reason: 'size-limit' } });
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
      expect(member).toMatchObject({ format: 'floway-request-dump', version: 3 });
      expect(member.record).toEqual(expected);
      offset += 512 + Math.ceil(size / 512) * 512;
    }
    expect(bytes.slice(offset)).toEqual(new Uint8Array(1024));
  });
});
