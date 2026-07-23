import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test } from 'vitest';

import { FsFileProvider } from './fs-file-provider.ts';
import { assertEquals } from '@floway-dev/test-utils';

const withTempRoot = async (fn: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'fs-file-provider-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test('put then get round-trips binary content', () => withTempRoot(async root => {
  const provider = new FsFileProvider(root);
  const bytes = new Uint8Array([0, 1, 2, 0xff, 0xfe, 0x80]);
  await provider.put('blobs/a.bin', bytes);
  const read = await provider.get('blobs/a.bin');
  assertEquals(read, bytes);
}));

test('get returns null for missing keys', () => withTempRoot(async root => {
  const provider = new FsFileProvider(root);
  const read = await provider.get('missing');
  assertEquals(read, null);
}));

test('listKeys returns empty array for missing prefix', () => withTempRoot(async root => {
  const provider = new FsFileProvider(root);
  assertEquals(await provider.listKeys('absent/dir'), []);
}));

test('listKeys returns recursive file paths under prefix using forward slashes', () => withTempRoot(async root => {
  const provider = new FsFileProvider(root);
  await provider.put('p/a.bin', new Uint8Array([1]));
  await provider.put('p/sub/b.bin', new Uint8Array([2]));
  await provider.put('q/c.bin', new Uint8Array([3]));
  const keys = (await provider.listKeys('p')).toSorted();
  assertEquals(keys, ['p/a.bin', 'p/sub/b.bin']);
}));

test('deletePrefix removes everything under the prefix and is no-op for missing', () => withTempRoot(async root => {
  const provider = new FsFileProvider(root);
  await provider.put('cleanup/a.bin', new Uint8Array([1]));
  await provider.put('cleanup/nested/b.bin', new Uint8Array([2]));
  await provider.put('keep/c.bin', new Uint8Array([3]));

  await provider.deletePrefix('cleanup');
  assertEquals(await provider.listKeys('cleanup'), []);
  assertEquals(await provider.get('keep/c.bin'), new Uint8Array([3]));

  // Second call on an already-cleaned prefix must not throw.
  await provider.deletePrefix('cleanup');
}));

test('put creates intermediate directories', () => withTempRoot(async root => {
  const provider = new FsFileProvider(root);
  await provider.put('deeply/nested/path/file.bin', new Uint8Array([42]));
  const read = await provider.get('deeply/nested/path/file.bin');
  assertEquals(read, new Uint8Array([42]));
}));
