import { test } from 'vitest';

import { gunzipBytes, gzipBytes } from '../../src/shared/gzip.ts';
import { assert, assertEquals } from '@floway-dev/test-utils';

const roundTrip = async (bytes: Uint8Array): Promise<Uint8Array> => await gunzipBytes(await gzipBytes(bytes));

test('gzipBytes emits the gzip container the stored artifacts are read back as', async () => {
  const gz = await gzipBytes(new TextEncoder().encode('floway'));
  // Stored payloads and dump bodies are persisted as `.gz` and decoded by
  // whichever runtime reads them later, so the magic number is part of the
  // on-disk contract rather than an implementation detail.
  assertEquals(gz[0], 0x1f);
  assertEquals(gz[1], 0x8b);
});

test('gzipBytes round-trips an empty payload', async () => {
  assertEquals((await roundTrip(new Uint8Array(0))).byteLength, 0);
});

test('gzipBytes round-trips text', async () => {
  const original = new TextEncoder().encode(JSON.stringify({ item: { type: 'message', content: '你好, Floway' } }));
  assertEquals(new TextDecoder().decode(await roundTrip(original)), new TextDecoder().decode(original));
});

test('gzipBytes round-trips every byte value', async () => {
  const original = new Uint8Array(256);
  for (let i = 0; i < original.length; i++) original[i] = i;
  assertEquals([...await roundTrip(original)], [...original]);
});

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

test('gunzipBytes rejects input that is not gzip', async () => {
  await gunzipBytes(new Uint8Array([1, 2, 3])).then(
    () => { throw new Error('expected gunzipBytes to reject non-gzip input'); },
    () => undefined,
  );
});
