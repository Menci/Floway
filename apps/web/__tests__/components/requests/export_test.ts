import { expect, it } from 'vitest';

import { exportRecords } from '../../../src/components/requests/export';
import { redactHeaderValue } from '../../../src/components/requests/header-redact';
import { decodeDump } from '@floway-dev/dump/browser';

const authorization = 'Bearer client-secret-token-1234567890abcd';
const archive = [
  `{"type":"object","fromObjectId":1,"nodes":[{"request.http":{"$":2}},{"headers":{"$":3}},[{"$":4},{"$":5}],["authorization",${JSON.stringify(authorization)}],["x-test","中文"],{"large":9007199254740993}]}`,
  '{"type":"stage.entered","stageId":1,"name":"parse","facts":{"$":1}}',
  '{"type":"stage.leaved","stageId":1,"facts":{"$":6}}',
  '',
].join('\n');

it('masks authorization through the header object reference and keeps exact NDJSON numbers', async () => {
  const result = JSON.parse(await exportRecords([{ id: 'one', archive }], false).text()) as { version: number; records: { id: string; archive: string }[] };
  expect(result.version).toBe(2);
  const embedded = result.records[0]!.archive;
  expect(embedded).not.toContain(authorization);
  expect(embedded).toContain(redactHeaderValue(authorization));
  expect(embedded).toContain('9007199254740993');
  const decoded = await decodeDump(new Response(embedded).body!);
  expect(decoded.rootStageId).toBe(1);
});

it('writes independent UTF-8 NDJSON members with valid tar sizes and checksums', async () => {
  const records = [{ id: 'one', archive }, { id: 'two', archive }];
  const bytes = new Uint8Array(await exportRecords(records, true).arrayBuffer());
  const decoder = new TextDecoder();
  let offset = 0;
  for (const expected of records) {
    const header = bytes.slice(offset, offset + 512);
    const field = (start: number, end: number) => decoder.decode(header.slice(start, end)).replace(/\0.*$/s, '').trim();
    expect(field(0, 100)).toBe(`${expected.id}.ndjson`);
    const checksum = parseInt(field(148, 156), 8);
    header.fill(32, 148, 156);
    expect(header.reduce((sum, byte) => sum + byte, 0)).toBe(checksum);
    const size = parseInt(field(124, 136), 8);
    const embedded = decoder.decode(bytes.slice(offset + 512, offset + 512 + size));
    expect(embedded).toContain('中文');
    expect(embedded).not.toContain(authorization);
    expect(await decodeDump(new Response(embedded).body!)).toMatchObject({ rootStageId: 1 });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  expect(bytes.slice(offset)).toEqual(new Uint8Array(1024));
});
