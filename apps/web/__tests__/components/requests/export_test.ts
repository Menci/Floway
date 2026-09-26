import { describe, expect, it } from 'vitest';

import { exportRecords } from '../../../src/components/requests/export';
import { redactHeaderValue } from '../../../src/components/requests/header-redact';
import type { DumpRecord } from '@floway-dev/gateway/dump-types';

const SECRET = 'Bearer client-secret-token-1234567890abcd';
const MASK = redactHeaderValue(SECRET);

const record = (id: string): DumpRecord => ({
  meta: { id, method: 'POST', path: '/v1/chat/completions', startedAt: 0, completedAt: 1000, status: 200, upstream: null, model: 'm', inputTokens: null, outputTokens: null, requestBytes: 0, responseBytes: 0, durationMs: 1000, error: null },
  request: { method: 'POST', path: '/v1/chat/completions', headers: [['authorization', SECRET], ['content-type', 'application/json']], body: { encoding: 'utf8', data: '中文 request' } },
  response: { status: 200, headers: [['set-cookie', SECRET]], body: { type: 'none' }, upstream: { status: 200, headers: [['api-key', SECRET]], body: { type: 'none' } } },
  capture: { exchanges: [{ upstreamId: 'u', request: { url: 'https://upstream.test', method: 'POST', headers: [['x-api-key', SECRET]], body: { encoding: 'utf8', data: '{"upstream":"translated request"}' } }, response: { status: 200, headers: [['x-goog-api-key', SECRET]], body: { encoding: 'utf8', data: 'data: {broken\n' }, complete: true, error: null }, error: null }], response: { body: { encoding: 'base64', data: '/4A=' }, complete: false, error: 'socket reset' } },
});

const redactedRecord = (id: string): DumpRecord => {
  const source = record(id);
  return {
    ...source,
    request: { ...source.request, headers: [['authorization', MASK], ['content-type', 'application/json']] },
    response: { ...source.response, headers: [['set-cookie', MASK]], upstream: { ...source.response.upstream!, headers: [['api-key', MASK]] } },
    capture: {
      ...source.capture!,
      exchanges: [{
        ...source.capture!.exchanges[0]!,
        request: { ...source.capture!.exchanges[0]!.request, headers: [['x-api-key', MASK]] },
        response: { ...source.capture!.exchanges[0]!.response!, headers: [['x-goog-api-key', MASK]] },
      }],
    },
  };
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

  it('preserves raw bytes, completeness and errors in combined JSON', async () => {
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
