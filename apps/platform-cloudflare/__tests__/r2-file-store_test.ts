import { expect, test } from 'vitest';

import {
  R2FileStore,
  R2_PART_BYTES,
  type R2BucketLike,
  type R2MultipartUploadLike,
  type R2UploadedPartLike,
} from '../src/r2-file-store.ts';
import { assertEquals } from '@floway-dev/test-utils';

class FakeR2Bucket implements R2BucketLike {
  store = new Map<string, Uint8Array>();
  deleteCalls: string[][] = [];
  parts: Uint8Array[] = [];
  aborted = false;

  async createMultipartUpload(key: string): Promise<R2MultipartUploadLike> {
    return {
      uploadPart: async (partNumber, value) => {
        this.parts.push(value.slice());
        return { partNumber, etag: String(partNumber) };
      },
      complete: async (_parts: R2UploadedPartLike[]) => {
        const bytes = new Uint8Array(this.parts.reduce((size, part) => size + part.byteLength, 0));
        let offset = 0;
        for (const part of this.parts) {
          bytes.set(part, offset);
          offset += part.byteLength;
        }
        this.store.set(key, bytes);
      },
      abort: async () => { this.aborted = true; },
    };
  }

  async put(key: string, value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null): Promise<unknown> {
    if (!(value instanceof Uint8Array)) throw new Error('FakeR2Bucket only supports Uint8Array');
    this.store.set(key, value.slice());
    return {};
  }

  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null> {
    const body = this.store.get(key);
    if (!body) return Promise.resolve(null);
    return Promise.resolve({ arrayBuffer: () => Promise.resolve(body.slice().buffer) });
  }

  async delete(keys: string | string[]): Promise<void> {
    const list = Array.isArray(keys) ? keys : [keys];
    this.deleteCalls.push([...list]);
    for (const key of list) this.store.delete(key);
  }

}

test('R2FileStore deletes exact keys in one R2 batch', async () => {
  const bucket = new FakeR2Bucket();
  await bucket.put('drop/a', new Uint8Array([1]));
  await bucket.put('drop/ab', new Uint8Array([2]));

  await new R2FileStore(bucket).deleteKeys(['drop/a', 'missing']);

  assertEquals([...bucket.store.keys()], ['drop/ab']);
  assertEquals(bucket.deleteCalls, [['drop/a', 'missing']]);
});

test('a streamed body below 5 MiB is published with one exact put at EOF', async () => {
  const bucket = new FakeR2Bucket();
  const store = new R2FileStore(bucket);
  const source = new TransformStream<Uint8Array, Uint8Array>();
  const writing = store.put('short', source.readable);
  const writer = source.writable.getWriter();
  await writer.write(new Uint8Array([1, 2]));
  await expect(store.get('short')).resolves.toBeNull();
  await writer.close();
  await writing;
  await expect(store.get('short')).resolves.toEqual(new Uint8Array([1, 2]));
  expect(bucket.parts).toEqual([]);
});

test('a streamed body crossing 5 MiB uses bounded multipart parts and publishes exact bytes', async () => {
  const bucket = new FakeR2Bucket();
  const store = new R2FileStore(bucket);
  const size = R2_PART_BYTES + 3;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(size).fill(7));
      controller.close();
    },
  });

  await store.put('large', source);
  expect(bucket.parts.map(part => part.byteLength)).toEqual([R2_PART_BYTES, 3]);
  const stored = await store.get('large');
  expect(stored?.byteLength).toBe(size);
  expect(stored?.every(byte => byte === 7)).toBe(true);
  expect(bucket.aborted).toBe(false);
});

test('a multipart boundary split across source fragments still uploads one full part', async () => {
  const bucket = new FakeR2Bucket();
  const store = new R2FileStore(bucket);
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(R2_PART_BYTES - 1).fill(1));
      controller.enqueue(new Uint8Array(2).fill(2));
      controller.close();
    },
  });

  await store.put('split', source);
  expect(bucket.parts.map(part => part.byteLength)).toEqual([R2_PART_BYTES, 1]);
  const stored = await store.get('split');
  expect(stored?.[R2_PART_BYTES - 2]).toBe(1);
  expect(stored?.[R2_PART_BYTES - 1]).toBe(2);
  expect(stored?.[R2_PART_BYTES]).toBe(2);
  expect(stored?.byteLength).toBe(R2_PART_BYTES + 1);
});

test('a streamed failure aborts multipart upload and preserves the prior object', async () => {
  const bucket = new FakeR2Bucket();
  const store = new R2FileStore(bucket);
  await store.put('large', new Uint8Array([9]));
  const failure = new Error('source interrupted');
  let pullCount = 0;
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pullCount++ === 0) controller.enqueue(new Uint8Array(R2_PART_BYTES));
      else controller.error(failure);
    },
  }, { highWaterMark: 0 });

  await expect(store.put('large', source)).rejects.toBe(failure);
  expect(bucket.aborted).toBe(true);
  await expect(store.get('large')).resolves.toEqual(new Uint8Array([9]));
});
