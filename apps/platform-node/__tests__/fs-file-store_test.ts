import { mkdtemp, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'vitest';

import { FsFileStore } from '../src/fs-file-store.ts';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

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

test('a concurrent read sees complete versions on both sides of an atomic replacement', () => withTempRoot(async root => {
  const key = 'atomic/value.bin';
  const initial = new Uint8Array([0x11, 0x22, 0x33]);
  const replacement = new Uint8Array([0xaa, 0xbb]);
  await new FsFileStore(root).put(key, initial);

  const temporaryWritten = Promise.withResolvers<void>();
  const allowReplacement = Promise.withResolvers<void>();
  const fileReplaced = Promise.withResolvers<void>();
  const allowCompletion = Promise.withResolvers<void>();
  const store = new FsFileStore(root, {
    writeTemporaryFile: async (path, body) => {
      await writeFile(path, body, { flag: 'wx' });
      temporaryWritten.resolve();
      await allowReplacement.promise;
    },
    replaceFile: async (temporaryPath, path) => {
      await rename(temporaryPath, path);
      fileReplaced.resolve();
      await allowCompletion.promise;
    },
  });

  const put = store.put(key, replacement);
  try {
    await temporaryWritten.promise;
    assertEquals(await store.get(key), initial);

    allowReplacement.resolve();
    await fileReplaced.promise;
    assertEquals(await store.get(key), replacement);
  } finally {
    allowReplacement.resolve();
    allowCompletion.resolve();
    await put;
  }
}));

test('deleteKeys prunes empty key directories while retaining shared and root directories', () => withTempRoot(async root => {
  const store = new FsFileStore(root);
  await store.put('shared/drop/item/body.bin', new Uint8Array([1]));
  await store.put('shared/keep/body.bin', new Uint8Array([2]));

  await store.deleteKeys(['shared/drop/item/body.bin']);

  assertEquals(await readdir(join(root, 'shared')), ['keep']);
  assertEquals(await store.get('shared/keep/body.bin'), new Uint8Array([2]));

  await store.deleteKeys(['shared/keep/body.bin']);

  await expect(stat(join(root, 'shared'))).rejects.toMatchObject({ code: 'ENOENT' });
  assertEquals((await stat(root)).isDirectory(), true);
}));

test('every operation rejects a key that resolves to the configured root', () => withTempRoot(async root => {
  const store = new FsFileStore(root);
  for (const key of ['', '.']) {
    await assertRejects(() => store.put(key, new Uint8Array()), Error, 'empty keys are not supported');
    await assertRejects(() => store.get(key), Error, 'empty keys are not supported');
    await assertRejects(() => store.deleteKeys([key]), Error, 'empty keys are not supported');
  }
}));

test('every operation rejects a key that escapes the configured root', () => withTempRoot(async root => {
  const store = new FsFileStore(join(root, 'files'));

  await assertRejects(() => store.put('../escaped.bin', new Uint8Array([1])), Error, 'key escapes root');
  await assertRejects(() => store.get('nested/../../escaped.bin'), Error, 'key escapes root');
  await assertRejects(() => store.deleteKeys(['../../../escaped.bin']), Error, 'key escapes root');
}));

test('every operation rejects absolute keys even when they point inside the root', () => withTempRoot(async root => {
  const store = new FsFileStore(root);
  const key = join(root, 'absolute.bin');

  await assertRejects(() => store.put(key, new Uint8Array([1])), Error, 'absolute keys are not supported');
  await assertRejects(() => store.get(key), Error, 'absolute keys are not supported');
  await assertRejects(() => store.deleteKeys([key]), Error, 'absolute keys are not supported');
}));
