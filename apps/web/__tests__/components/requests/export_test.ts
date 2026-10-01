import { describe, expect, it } from 'vitest';

import { exportRecords } from '../../../src/components/requests/export';
import { redactHeaderValue } from '../../../src/components/requests/header-redact';
import type { DumpRecord } from '@floway-dev/dump/types';

const SECRET = 'Bearer client-secret-token-1234567890abcd';
const MASK = redactHeaderValue(SECRET);

const record = (id: string): DumpRecord => ({
  meta: { id, method: 'POST', path: '/v1/chat/completions', startedAt: 0, completedAt: 1000, status: 200, upstream: null, model: 'm', inputTokens: null, outputTokens: null, requestBytes: 0, responseBytes: 0, durationMs: 1000, error: null },
  events: [
    { type: 'object', fromObjectId: 1, nodes: [[['authorization', SECRET], ['content-type', 'application/json']]] },
    { type: 'stage.leaved', stageId: 1, facts: { 'response.http.headers': { $: 1 }, 'response.text': '中文 response' } },
  ].map(event => JSON.stringify(event)).join('\n'),
});

const redactedRecord = (id: string): DumpRecord => {
  const source = record(id);
  return { ...source, events: `${source.events.replace(SECRET, MASK)}\n` };
};

describe('request export', () => {
  it('masks every credential header and keeps the rest intact', async () => {
    const [exported] = JSON.parse(await exportRecords([record('one')], false).text()).records;
    expect(exported).toEqual(redactedRecord('one'));
  });

  it('leaves no trace of the credential values in either export format', async () => {
    expect(await exportRecords([record('one'), record('two')], false).text()).not.toContain(SECRET);
    expect(new TextDecoder().decode(new Uint8Array(await exportRecords([record('one')], true).arrayBuffer()))).not.toContain(SECRET);
  });

  it('preserves facts and protocol records in combined JSON', async () => {
    const records = [record('one'), record('two')];
    expect(JSON.parse(await exportRecords(records, false).text())).toEqual({ format: 'floway-request-dump', version: 1, records: [redactedRecord('one'), redactedRecord('two')] });
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
      expect(JSON.parse(decoder.decode(bytes.slice(offset + 512, offset + 512 + size))).record).toEqual(redactedRecord(expected.meta.id));
      offset += 512 + Math.ceil(size / 512) * 512;
    }
    expect(bytes.slice(offset)).toEqual(new Uint8Array(1024));
  });
});
