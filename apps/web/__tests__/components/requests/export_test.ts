import { describe, expect, it } from 'vitest';

import { exportRecords } from '../../../src/components/requests/export';
import type { DumpRecord } from '@floway-dev/gateway/dump-types';

const record = (id: string): DumpRecord => ({
  meta: { id, method: 'POST', path: '/v1/chat/completions', startedAt: 0, completedAt: 1000, status: 200, upstream: null, model: 'm', inputTokens: null, outputTokens: null, requestBytes: 0, responseBytes: 0, durationMs: 1000, error: null },
  request: { method: 'POST', path: '/v1/chat/completions', headers: [], body: { encoding: 'utf8', data: '中文 request' } },
  response: { status: 200, headers: [], body: { type: 'none' } },
  capture: { exchanges: [], response: { body: { encoding: 'base64', data: '/4A=' }, complete: false, error: 'socket reset' } },
});

describe('request export', () => {
  it('preserves raw bytes, completeness and errors in combined JSON', async () => {
    const records = [record('one'), record('two')];
    expect(JSON.parse(await exportRecords(records, false).text())).toEqual({ format: 'floway-request-dump', version: 1, records });
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
      expect(JSON.parse(decoder.decode(bytes.slice(offset + 512, offset + 512 + size))).record).toEqual(expected);
      offset += 512 + Math.ceil(size / 512) * 512;
    }
    expect(bytes.slice(offset)).toEqual(new Uint8Array(1024));
  });
});
