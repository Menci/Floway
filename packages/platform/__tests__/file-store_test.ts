import { expect, test } from 'vitest';

import { MemoryFileStore } from '../src/file-store.ts';

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
