import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
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

test('concurrent replacements expose only complete file versions', () => withTempRoot(async root => {
  const store = new FsFileStore(root);
  const size = 1024 * 1024;
  const initial = new Uint8Array(size).fill(0x11);
  const first = new Uint8Array(size).fill(0x55);
  const second = new Uint8Array(size).fill(0xaa);
  await store.put('atomic/value.bin', initial);

  let completed = false;
  const replacements = Promise.all([
    store.put('atomic/value.bin', first),
    store.put('atomic/value.bin', second),
  ]).finally(() => { completed = true; });
  const assertCompleteVersion = (value: Uint8Array): void => {
    assertEquals(value.byteLength, size);
    const byte = value[0]!;
    assertEquals([0x11, 0x55, 0xaa].includes(byte), true);
    assertEquals(value.every(current => current === byte), true);
  };
  let observations = 0;
  while (!completed && observations < 2) {
    assertCompleteVersion((await store.get('atomic/value.bin'))!);
    observations += 1;
  }
  await replacements;
  assertCompleteVersion((await store.get('atomic/value.bin'))!);
  assertEquals(observations > 0, true);
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
