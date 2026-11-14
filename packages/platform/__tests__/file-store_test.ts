import { expect, test } from 'vitest';

import { getFileStore, initFileStore, MemoryFileStore } from '../src/file-store.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('MemoryFileStore clones at the store boundary', async () => {
  const store = new MemoryFileStore();
  const body = new Uint8Array([1, 2, 3]);

  await store.put('k', body);
  body[0] = 9;

  const first = await store.get('k');
  assertEquals(first ? [...first] : null, [1, 2, 3]);
  first![1] = 8;

  assertEquals([...(await store.get('k'))!], [1, 2, 3]);
});

test('runtime exposes one initialized FileStore instance', async () => {
  const store = new MemoryFileStore();
  initFileStore(store);

  await getFileStore().put('k', new Uint8Array([4]));
  assertEquals([...(await store.get('k'))!], [4]);
});

test('MemoryFileStore deletes exact keys without treating them as prefixes', async () => {
  const store = new MemoryFileStore();
  await store.put('drop/a', new Uint8Array([1]));
  await store.put('drop/ab', new Uint8Array([2]));

  await store.deleteKeys(['drop/a', 'missing']);

  assertEquals(await store.get('drop/a'), null);
  assertEquals(await store.get('drop/ab'), new Uint8Array([2]));
});

test('MemoryFileStore accepts streamed bytes and publishes only at completion', async () => {
  const store = new MemoryFileStore();
  const source = new TransformStream<Uint8Array, Uint8Array>();
  const writing = store.put('stream', source.readable);
  const writer = source.writable.getWriter();
  await writer.write(new Uint8Array([1, 2]));
  expect(await store.get('stream')).toBeNull();
  await writer.write(new Uint8Array([3]));
  await writer.close();
  await writing;
  expect(await store.get('stream')).toEqual(new Uint8Array([1, 2, 3]));
});
