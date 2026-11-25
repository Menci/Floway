import { expect, test } from 'vitest';

import { exportArchives } from '../../../src/components/requests/export';

const archives = [
  { id: 'first', contents: '{"type":"object","fromObjectId":1,"nodes":[{"text":"测试"}]}\n' },
  { id: 'second', contents: '{"type":"object","fromObjectId":1,"nodes":[900719925474099312345]}\n' },
];

test('preserves independent event spaces and exact text in both batch export formats', async () => {
  expect(JSON.parse(await exportArchives(archives, false).text())).toEqual({ records: archives });
  const bytes = new Uint8Array(await exportArchives(archives, true).arrayBuffer());
  const decoder = new TextDecoder();
  let offset = 0;
  for (const archive of archives) {
    const header = bytes.slice(offset, offset + 512);
    const field = (start: number, end: number) => decoder.decode(header.slice(start, end)).replace(/\0.*$/s, '').trim();
    expect(field(0, 100)).toBe(`${archive.id}.ndjson`);
    const checksum = parseInt(field(148, 156), 8);
    header.fill(32, 148, 156);
    expect(header.reduce((sum, byte) => sum + byte, 0)).toBe(checksum);
    const size = parseInt(field(124, 136), 8);
    expect(decoder.decode(bytes.slice(offset + 512, offset + 512 + size))).toBe(archive.contents);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  expect(bytes.slice(offset)).toEqual(new Uint8Array(1024));
});
