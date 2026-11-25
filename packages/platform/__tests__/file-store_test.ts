import { expect, test } from 'vitest';

import { MemoryFileStore } from '../src/file-store.ts';

test('stores complete streamed bytes in order', async () => {
  const store = new MemoryFileStore();
  const chunks = [Uint8Array.of(0xff), Uint8Array.of(0, 2)];
  await store.putStream('archive', new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }));
  expect(await store.get('archive')).toEqual(Uint8Array.of(0xff, 0, 2));
  const body = await store.getStream('archive');
  expect(new Uint8Array(await new Response(body).arrayBuffer())).toEqual(Uint8Array.of(0xff, 0, 2));
  expect(await store.getStream('missing')).toBeNull();
});
