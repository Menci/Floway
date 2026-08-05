import { test } from 'vitest';

import { R2FileStore, type R2BucketLike } from '../src/r2-file-store.ts';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

class FakeR2Bucket implements R2BucketLike {
  store = new Map<string, Uint8Array>();
  deleteCalls: string[][] = [];

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

test('R2FileStore splits deletion at the 1000-key API boundary', async () => {
  const bucket = new FakeR2Bucket();
  const keys = Array.from({ length: 1_001 }, (_, index) => `key-${index}`);

  await new R2FileStore(bucket).deleteKeys(keys);

  assertEquals(bucket.deleteCalls.map(call => call.length), [1_000, 1]);
  assertEquals(bucket.deleteCalls.flat(), keys);
});

test('R2FileStore propagates a failed batch and does not start later batches', async () => {
  const deleteCalls: string[][] = [];
  const bucket: R2BucketLike = {
    put: () => Promise.resolve(),
    get: () => Promise.resolve(null),
    delete(keys) {
      const batch = Array.isArray(keys) ? keys : [keys];
      deleteCalls.push([...batch]);
      return deleteCalls.length === 2
        ? Promise.reject(new Error('R2 unavailable'))
        : Promise.resolve();
    },
  };

  await assertRejects(
    () => new R2FileStore(bucket).deleteKeys(Array.from({ length: 2_001 }, (_, index) => `key-${index}`)),
    Error,
    'R2 unavailable',
  );

  assertEquals(deleteCalls.map(call => call.length), [1_000, 1_000]);
});
