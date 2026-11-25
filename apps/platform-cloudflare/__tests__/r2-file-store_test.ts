import { expect, test } from 'vitest';

import { R2FileStore, type R2BucketLike } from '../src/r2-file-store.ts';
import { assertEquals } from '@floway-dev/test-utils';

class FakeR2Bucket implements R2BucketLike {
  store = new Map<string, Uint8Array>();
  deleteCalls: string[][] = [];
  parts: Uint8Array[] = [];
  firstPart = Promise.withResolvers<void>();
  uploadError?: Error;
  aborted = false;
  singlePuts = 0;

  async put(key: string, value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null): Promise<unknown> {
    if (!(value instanceof Uint8Array)) throw new Error('FakeR2Bucket only supports Uint8Array');
    this.singlePuts++;
    this.store.set(key, value.slice());
    return {};
  }

  async createMultipartUpload(key: string): ReturnType<R2BucketLike['createMultipartUpload']> {
    return {
      uploadPart: async (partNumber, body) => {
        if (this.uploadError) throw this.uploadError;
        assertEquals(partNumber, this.parts.length + 1);
        this.parts.push(body.slice());
        this.firstPart.resolve();
        return { partNumber, etag: String(partNumber) };
      },
      complete: async parts => {
        assertEquals(parts.map(part => part.partNumber), this.parts.map((_, index) => index + 1));
        const merged = new Uint8Array(this.parts.reduce((size, data) => size + data.length, 0));
        let offset = 0;
        for (const data of this.parts) {
          merged.set(data, offset);
          offset += data.length;
        }
        this.store.set(key, merged);
      },
      abort: async () => { this.aborted = true; },
    };
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

test('R2FileStore sends a small archive with one put', async () => {
  const bucket = new FakeR2Bucket();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Uint8Array.of(0, 0xff));
      controller.enqueue(Uint8Array.of(2));
      controller.close();
    },
  });
  await new R2FileStore(bucket).putStream('dump', body);
  expect(bucket.singlePuts).toBe(1);
  expect(bucket.parts).toHaveLength(0);
  expect(bucket.store.get('dump')).toEqual(Uint8Array.of(0, 0xff, 2));
});

const partSize = 5 * 1024 * 1024;

test('R2FileStore uploads full parts before archive input ends', async () => {
  const bucket = new FakeR2Bucket();
  const end = Promise.withResolvers<void>();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(new Uint8Array(partSize).fill(3));
      await end.promise;
      controller.enqueue(Uint8Array.of(4, 5));
      controller.close();
    },
  });
  const write = new R2FileStore(bucket).putStream('dump', body);
  try {
    await bucket.firstPart.promise;
    expect(bucket.store.has('dump')).toBe(false);
    expect(bucket.parts[0]?.length).toBe(partSize);
  } finally {
    end.resolve();
    await write;
  }
  expect(bucket.singlePuts).toBe(0);
  expect(bucket.parts.map(part => part.length)).toEqual([partSize, 2]);
  expect(bucket.store.get('dump')?.slice(partSize - 1)).toEqual(Uint8Array.of(3, 4, 5));
});

test('R2FileStore cancels input and aborts unfinished multipart uploads', async () => {
  const bucket = new FakeR2Bucket();
  const error = new Error('unavailable upload');
  bucket.uploadError = error;
  let cancelReason: unknown;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(partSize)); },
    cancel(reason) { cancelReason = reason; },
  });
  await expect(new R2FileStore(bucket).putStream('dump', body)).rejects.toBe(error);
  expect(bucket.aborted).toBe(true);
  expect(cancelReason).toBe(error);
  expect(bucket.store.has('dump')).toBe(false);
});
