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

test('deleteKeys removes exact files and ignores missing keys', () => withTempRoot(async root => {
  const store = new FsFileStore(root);
  await store.put('cleanup/a.bin', new Uint8Array([1]));
  await store.put('cleanup/ab.bin', new Uint8Array([2]));

  await store.deleteKeys(['cleanup/a.bin', 'missing.bin']);

  assertEquals(await store.get('cleanup/a.bin'), null);
  assertEquals(await store.get('cleanup/ab.bin'), new Uint8Array([2]));
}));
