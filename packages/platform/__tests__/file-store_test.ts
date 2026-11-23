import { expect, test } from 'vitest';

import { MemoryFileStore } from '../src/file-store.ts';

test('MemoryFileStore accepts streamed bytes and publishes only at completion', async () => {
  const store = new MemoryFileStore();
  const source = new TransformStream<Uint8Array, Uint8Array>();
  const writing = store.put('stream', source.readable);
  const writer = source.writable.getWriter();
  await writer.write(new Uint8Array([1, 2]));
  await expect(store.get('stream')).resolves.toBeNull();
  await writer.write(new Uint8Array([3]));
  await writer.close();
  await writing;
  await expect(store.get('stream')).resolves.toEqual(new Uint8Array([1, 2, 3]));
});

test('MemoryFileStore preserves an existing value until a streamed replacement completes', async () => {
  const store = new MemoryFileStore();
  await store.put('stream', new Uint8Array([9]));
  const source = new TransformStream<Uint8Array, Uint8Array>();
  const writing = store.put('stream', source.readable);
  const writer = source.writable.getWriter();
  await writer.write(new Uint8Array([1]));
  await expect(store.get('stream')).resolves.toEqual(new Uint8Array([9]));
  await writer.close();
  await writing;
  await expect(store.get('stream')).resolves.toEqual(new Uint8Array([1]));
});

test('MemoryFileStore leaves its prior value intact when the source errors', async () => {
  const store = new MemoryFileStore();
  await store.put('stream', new Uint8Array([9]));
  const failure = new Error('source failed');
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(failure);
    },
  });

  await expect(store.put('stream', source)).rejects.toMatchObject({ errors: expect.arrayContaining([failure]) });
  await expect(store.get('stream')).resolves.toEqual(new Uint8Array([9]));
});

test('MemoryFileStore releases a completed source lock', async () => {
  const store = new MemoryFileStore();
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1]));
      controller.close();
    },
  });
  await store.put('stream', source);
  expect(source.locked).toBe(false);
});
