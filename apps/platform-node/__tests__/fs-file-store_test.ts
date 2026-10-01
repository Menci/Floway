import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test } from 'vitest';

import { FsFileStore } from '../src/fs-file-store.ts';
import { assertEquals } from '@floway-dev/test-utils';

const withTempRoot = async (fn: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'fs-file-store-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test('put then get round-trips binary content', () => withTempRoot(async root => {
  const store = new FsFileStore(root);
  const bytes = new Uint8Array([0, 1, 2, 0xff, 0xfe, 0x80]);
  await store.put('blobs/a.bin', bytes);
  const read = await store.get('blobs/a.bin');
  assertEquals(read, bytes);
}));

test('get returns null for missing keys', () => withTempRoot(async root => {
  const store = new FsFileStore(root);
  const read = await store.get('missing');
  assertEquals(read, null);
}));

test('deleteKeys removes exact files and ignores missing keys', () => withTempRoot(async root => {
  const store = new FsFileStore(root);
  await store.put('cleanup/a.bin', new Uint8Array([1]));
  await store.put('cleanup/ab.bin', new Uint8Array([2]));

  await store.deleteKeys(['cleanup/a.bin', 'missing.bin']);

  assertEquals(await store.get('cleanup/a.bin'), null);
  assertEquals(await store.get('cleanup/ab.bin'), new Uint8Array([2]));
}));

test('put creates intermediate directories', () => withTempRoot(async root => {
  const store = new FsFileStore(root);
  await store.put('deeply/nested/path/file.bin', new Uint8Array([42]));
  const read = await store.get('deeply/nested/path/file.bin');
  assertEquals(read, new Uint8Array([42]));
}));
