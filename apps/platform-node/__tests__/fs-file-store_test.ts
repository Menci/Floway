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

test('deleteKeys removes exact files and ignores missing keys', () => withTempRoot(async root => {
  const store = new FsFileStore(root);
  await store.put('cleanup/a.bin', new Uint8Array([1]));
  await store.put('cleanup/ab.bin', new Uint8Array([2]));

  await store.deleteKeys(['cleanup/a.bin', 'missing.bin']);

  assertEquals(await store.get('cleanup/a.bin'), null);
  assertEquals(await store.get('cleanup/ab.bin'), new Uint8Array([2]));
}));

test('a streamed replacement is private until EOF and publishes complete bytes atomically', () => withTempRoot(async root => {
  const store = new FsFileStore(root);
  await store.put('file', new Uint8Array([9]));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let pullCount = 0;
  const writing = store.put('file', new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (pullCount++ === 0) {
        controller.enqueue(new Uint8Array([1, 2]));
      } else {
        await gate;
        controller.enqueue(new Uint8Array([3, 4]));
        controller.close();
      }
    },
  }, { highWaterMark: 0 }));

  await expect.poll(() => pullCount).toBe(2);
  await expect(store.get('file')).resolves.toEqual(new Uint8Array([9]));
  release();
  await writing;
  await expect(store.get('file')).resolves.toEqual(new Uint8Array([1, 2, 3, 4]));
  expect(await readdir(root)).toEqual(['.floway-staging', 'file']);
  const stagingDirectories = await readdir(join(root, '.floway-staging'));
  expect(stagingDirectories).toHaveLength(1);
  expect(await readdir(join(root, '.floway-staging', stagingDirectories[0]!))).toEqual([]);
}));

test('a mid-stream error removes staging data and preserves the prior destination', () => withTempRoot(async root => {
  const store = new FsFileStore(root);
  await store.put('file', new Uint8Array([9]));
  const failure = new Error('source interrupted');
  let pullCount = 0;
  const writing = store.put('file', new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pullCount++ === 0) controller.enqueue(new Uint8Array([1, 2]));
      else controller.error(failure);
    },
  }, { highWaterMark: 0 }));

  await expect(writing).rejects.toBe(failure);
  await expect(store.get('file')).resolves.toEqual(new Uint8Array([9]));
  expect(await readdir(root)).toEqual(['.floway-staging', 'file']);
  const stagingDirectories = await readdir(join(root, '.floway-staging'));
  expect(stagingDirectories).toHaveLength(1);
  expect(await readdir(join(root, '.floway-staging', stagingDirectories[0]!))).toEqual([]);
}));

test.each([
  '../escape',
  'nested/../../escape',
  '/absolute',
])('FsFileStore rejects path escape %s', key => withTempRoot(async root => {
  const store = new FsFileStore(root);
  await expect(store.put(key, new Uint8Array([1]))).rejects.toThrow();
  await expect(store.get(key)).rejects.toThrow();
  await expect(store.deleteKeys([key])).rejects.toThrow();
}));

test.each(['.floway-staging', '.FLOWAY-STAGING', '.Floway-Staging'])('FsFileStore reserves staging segment %s', segment => withTempRoot(async root => {
  const store = new FsFileStore(root);
  await expect(store.put(`nested/${segment}/file`, new Uint8Array([1]))).rejects.toThrow('reserved staging segment');
  await expect(store.get(`${segment}/file`)).rejects.toThrow('reserved staging segment');
  await expect(store.deleteKeys([`${segment}/file`])).rejects.toThrow('reserved staging segment');
}));

test('deleteKeys removes the orphan staging directory for the exact target basename', () => withTempRoot(async root => {
  const store = new FsFileStore(root);
  await store.put('nested/target', new Uint8Array([1]));
  await store.put('nested/other', new Uint8Array([2]));
  await store.deleteKeys(['nested/target']);
  await expect(store.get('nested/target')).resolves.toBeNull();
  await expect(store.get('nested/other')).resolves.toEqual(new Uint8Array([2]));
  expect(await readdir(join(root, 'nested', '.floway-staging'))).toHaveLength(1);
}));

test('concurrent writers publish complete values through distinct staging timestamps', () => withTempRoot(async root => {
  const store = new FsFileStore(root);
  await Promise.all([
    store.put('same', new Uint8Array([1])),
    store.put('same', new Uint8Array([2])),
    store.put('same', new Uint8Array([3])),
  ]);
  const stored = await store.get('same');
  expect([[1], [2], [3]]).toContainEqual([...stored!]);
  const stagingDirectories = await readdir(join(root, '.floway-staging'));
  expect(await readdir(join(root, '.floway-staging', stagingDirectories[0]!))).toEqual([]);
}));
