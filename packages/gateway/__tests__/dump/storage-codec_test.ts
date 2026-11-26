import { expect, test } from 'vitest';

import { fakeMeta } from './test-fixtures.ts';
import { dumpCodec } from '../../src/dump/codec.ts';
import { decodeDumpBodyDescriptor, decodePersistedDumpMetadata, encodeDumpBodyDescriptor, encodePersistedDumpMetadata } from '../../src/dump/storage-codec.ts';

test('dump broker frames reject valid JSON with malformed metadata', () => {
  const frame = {
    event: 'appended',
    data: { ...fakeMeta(), status: '200' },
  };

  expect(() => dumpCodec.decode(JSON.stringify(frame)))
    .toThrow();
});

test('persists archive metadata and its storage descriptor', () => {
  const { upstream: _upstream, ...meta } = fakeMeta({ ttftMs: 120 });
  const descriptor = { key: 'dumps/archive.ndjson.gz', type: 'archive' as const };
  expect(decodePersistedDumpMetadata(encodePersistedDumpMetadata({ ...meta, upstream: null }, 'archive'), 'archive')).toEqual(meta);
  expect(decodeDumpBodyDescriptor(encodeDumpBodyDescriptor(descriptor, 'archive'), 'archive')).toEqual(descriptor);
});
