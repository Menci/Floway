import { test } from 'vitest';

import { R2FileProvider, type R2BucketLike } from './r2-file-provider.ts';
import { assertEquals } from '@floway-dev/test-utils';

class FakeR2Bucket implements R2BucketLike {
  store = new Map<string, Uint8Array>();
  pageLimit = 2;
  listCalls = 0;
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

  list(options: { prefix: string; cursor?: string; limit?: number }): Promise<{
    objects: readonly { key: string }[];
    truncated: boolean;
    cursor?: string;
  }> {
    this.listCalls += 1;
    const limit = Math.min(options.limit ?? this.pageLimit, this.pageLimit);
    const matching = [...this.store.keys()].filter(key => key.startsWith(options.prefix)).toSorted();
    const startIndex = options.cursor ? matching.indexOf(options.cursor) : 0;
    const page = matching.slice(startIndex, startIndex + limit);
    const nextIndex = startIndex + limit;
    const truncated = nextIndex < matching.length;
    return Promise.resolve({
      objects: page.map(key => ({ key })),
      truncated,
      cursor: truncated ? matching[nextIndex] : undefined,
    });
  }
}

test('R2FileProvider deletePrefix paginates listing and batch-deletes every page', async () => {
  const bucket = new FakeR2Bucket();
  for (let i = 0; i < 5; i += 1) await bucket.put(`drop/${i}.json`, new Uint8Array([i]));
  await bucket.put('keep/a', new Uint8Array([9]));

  const provider = new R2FileProvider(bucket);
  await provider.deletePrefix('drop/');

  assertEquals(bucket.store.has('keep/a'), true);
  assertEquals([...bucket.store.keys()].filter(key => key.startsWith('drop/')), []);
  assertEquals(bucket.listCalls, 3);
  assertEquals(bucket.deleteCalls.length, 3);
});

test('R2FileProvider deletePrefix is a no-op when nothing matches the prefix', async () => {
  const bucket = new FakeR2Bucket();
  await bucket.put('keep/a', new Uint8Array([1]));

  const provider = new R2FileProvider(bucket);
  await provider.deletePrefix('drop/');

  assertEquals(bucket.deleteCalls, []);
});

test('R2FileProvider listKeys paginates the listing and returns every matching key', async () => {
  const bucket = new FakeR2Bucket();
  for (let i = 0; i < 5; i += 1) await bucket.put(`scan/${i}.json`, new Uint8Array([i]));
  await bucket.put('other/a', new Uint8Array([9]));

  const provider = new R2FileProvider(bucket);

  assertEquals((await provider.listKeys('scan/')).toSorted(), ['scan/0.json', 'scan/1.json', 'scan/2.json', 'scan/3.json', 'scan/4.json']);
  assertEquals(bucket.listCalls, 3);
});
