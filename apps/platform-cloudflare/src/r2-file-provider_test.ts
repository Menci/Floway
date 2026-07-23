import { test } from 'vitest';

import { R2FileProvider, type R2BucketLike } from './r2-file-provider.ts';
import { assertEquals } from '@floway-dev/test-utils';

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

  list(options: { prefix: string; cursor?: string; limit: number }): Promise<{
    objects: Array<{ key: string }>;
    truncated: boolean;
    cursor?: string;
  }> {
    const candidates = [...this.store.keys()]
      .filter(key => key.startsWith(options.prefix) && (options.cursor === undefined || key > options.cursor))
      .sort();
    const keys = candidates.slice(0, options.limit);
    const truncated = candidates.length > keys.length;
    return Promise.resolve({
      objects: keys.map(key => ({ key })),
      truncated,
      ...(truncated ? { cursor: keys.at(-1)! } : {}),
    });
  }

  async delete(keys: string | string[]): Promise<void> {
    const list = Array.isArray(keys) ? keys : [keys];
    this.deleteCalls.push([...list]);
    for (const key of list) this.store.delete(key);
  }

}

test('R2FileProvider deletes exact keys in one R2 batch', async () => {
  const bucket = new FakeR2Bucket();
  await bucket.put('drop/a', new Uint8Array([1]));
  await bucket.put('drop/ab', new Uint8Array([2]));

  await new R2FileProvider(bucket).deleteKeys(['drop/a', 'missing']);

  assertEquals([...bucket.store.keys()], ['drop/ab']);
  assertEquals(bucket.deleteCalls, [['drop/a', 'missing']]);
});

test('R2FileProvider preserves opaque cursors across bounded listings', async () => {
  const bucket = new FakeR2Bucket();
  await bucket.put('dumps/a', new Uint8Array());
  await bucket.put('dumps/b', new Uint8Array());
  await bucket.put('other/c', new Uint8Array());
  const provider = new R2FileProvider(bucket);

  const first = await provider.listPage('dumps/', null, 1);
  const second = await provider.listPage('dumps/', first.nextCursor, 1);

  assertEquals(first, { keys: ['dumps/a'], nextCursor: 'dumps/a' });
  assertEquals(second, { keys: ['dumps/b'], nextCursor: null });
});
