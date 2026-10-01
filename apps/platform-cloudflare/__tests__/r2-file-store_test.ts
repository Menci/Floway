import { expect, test } from 'vitest';

import { R2FileStore, type R2BucketLike, type R2MultipartUploadLike, type R2UploadedPartLike } from '../src/r2-file-store.ts';
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
        for (const part of this.parts) { bytes.set(part, offset); offset += part.byteLength; }
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

test('unknown-length streaming writes keep parts bounded and publish exact bytes at EOF', async () => {
  const bucket = new FakeR2Bucket();
  const store = new R2FileStore(bucket);
  const size = 5 * 1024 * 1024;
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  let chunk = 0;
  const source = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (chunk++ === 0) controller.enqueue(new Uint8Array(size + 3).fill(7));
      else { await gate; controller.close(); }
    },
  }, { highWaterMark: 0 });
  const writing = store.put('stream', source);
  await expect.poll(() => bucket.parts.length).toBe(1);
  expect(bucket.parts[0]?.byteLength).toBe(size);
  expect(await store.get('stream')).toBeNull();
  finish();
  await writing;
  expect(bucket.parts.map(part => part.byteLength)).toEqual([size, 3]);
  const stored = (await store.get('stream'))!;
  expect(stored.byteLength).toBe(size + 3);
  expect(stored.every(byte => byte === 7)).toBe(true);
  expect(bucket.aborted).toBe(false);
});

test.each([0, 3])('a short stream of %i bytes uses a complete single put', async size => {
  const bucket = new FakeR2Bucket();
  const store = new R2FileStore(bucket);
  await store.put('short', new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(size)); controller.close(); } }));
  expect(await store.get('short')).toEqual(new Uint8Array(size));
  expect(bucket.parts).toEqual([]);
});

test('a failed streamed upload leaves the previous object and preserves the original error', async () => {
  const bucket = new FakeR2Bucket();
  const store = new R2FileStore(bucket);
  await store.put('failed', new Uint8Array([9]));
  const error = new Error('source interrupted');
  let chunk = 0;
  await expect(store.put('failed', new ReadableStream({
    pull(controller) {
      if (chunk++ === 0) controller.enqueue(new Uint8Array(5 * 1024 * 1024));
      else controller.error(error);
    },
  }, { highWaterMark: 0 }))).rejects.toBe(error);
  expect(bucket.aborted).toBe(true);
  expect(await store.get('failed')).toEqual(new Uint8Array([9]));
});
