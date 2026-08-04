import { expect, test } from 'vitest';

import { fakeMeta } from './test-fixtures.ts';
import { dumpCodec } from '../../src/dump/codec.ts';
import {
  decodeDumpHeaders,
  encodeDumpHeaders,
} from '../../src/dump/storage-codec.ts';

test('dump storage headers preserve duplicate pairs and their order', () => {
  const headers: Array<[string, string]> = [
    ['set-cookie', 'a=1'],
    ['x-empty', ''],
    ['set-cookie', 'b=2'],
  ];

  expect(decodeDumpHeaders(encodeDumpHeaders(headers, 'test headers'), 'test headers')).toEqual(headers);
});

test('dump broker frames round-trip metadata through the shared schema', () => {
  const metadata = fakeMeta({
    upstream: { id: 'upstream-a', name: 'A', kind: 'custom', hue: 42 },
    error: { kind: 'failed', reason: 'connection closed' },
  });

  expect(dumpCodec.decode(dumpCodec.encode(metadata))).toEqual(metadata);
});

test('dump broker frames reject valid JSON with malformed metadata', () => {
  const frame = {
    event: 'appended',
    data: { ...fakeMeta(), status: '200' },
  };

  expect(() => dumpCodec.decode(JSON.stringify(frame)))
    .toThrow(/Invalid dump broker frame.*status/su);
});
