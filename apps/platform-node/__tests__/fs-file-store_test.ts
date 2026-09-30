import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'vitest';

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

test('a streamed replacement stays private until EOF and publishes complete binary bytes', () => withTempRoot(async root => {
  const store = new FsFileStore(root);
  await store.put('file', new Uint8Array([9]));
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  let chunk = 0;
  const writing = store.put('file', new ReadableStream({
    async pull(controller) {
      if (chunk++ === 0) controller.enqueue(new Uint8Array([1, 2]));
      else { await gate; controller.enqueue(new Uint8Array([3, 4])); controller.close(); }
    },
  }, { highWaterMark: 0 }));
  await expect.poll(() => chunk).toBe(2);
  expect(await store.get('file')).toEqual(new Uint8Array([9]));
  finish();
  await writing;
  expect(await store.get('file')).toEqual(new Uint8Array([1, 2, 3, 4]));
  expect(await readdir(root)).toEqual(['file']);
}));

test('source failure removes staging data without replacing the prior file', () => withTempRoot(async root => {
  const store = new FsFileStore(root);
  await store.put('file', new Uint8Array([9]));
  const error = new Error('source interrupted');
  let chunk = 0;
  await expect(store.put('file', new ReadableStream({
    pull(controller) {
      if (chunk++ === 0) controller.enqueue(new Uint8Array([1, 2]));
      else controller.error(error);
    },
  }, { highWaterMark: 0 }))).rejects.toBe(error);
  expect(await store.get('file')).toEqual(new Uint8Array([9]));
  expect(await readdir(root)).toEqual(['file']);
}));
