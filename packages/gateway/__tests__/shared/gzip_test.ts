import { test } from 'vitest';

import { gunzipBytes, gzipBytes } from '../../src/shared/gzip.ts';
import { assert, assertEquals } from '@floway-dev/test-utils';

const roundTrip = async (bytes: Uint8Array): Promise<Uint8Array> => await gunzipBytes(await gzipBytes(bytes));

test('gzipBytes round-trips a payload larger than one stream chunk', async () => {
  const original = new Uint8Array(1024 * 1024);
  // A repeating byte pattern rather than a constant fill, so the assertion
  // would catch a chunk that arrived out of order as well as one that was lost.
  for (let i = 0; i < original.length; i++) original[i] = (i * 31) & 0xff;
  const restored = await roundTrip(original);
  assertEquals(restored.byteLength, original.byteLength);
  assert(restored.every((byte, index) => byte === original[index]), 'restored bytes diverged from the original');
});

test('gzipBytes accepts a view over a larger buffer', async () => {
  const backing = new Uint8Array(64);
  backing.fill(7);
  const view = backing.subarray(16, 48);
  assertEquals([...await roundTrip(view)], [...view]);
});
