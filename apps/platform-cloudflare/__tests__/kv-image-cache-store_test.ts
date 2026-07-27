import { test } from 'vitest';

import { KvImageCacheStore, type KvNamespace } from '../src/kv-image-cache-store.ts';
import type { ImageCachePolicy } from '@floway-dev/platform';
import { assert, assertEquals } from '@floway-dev/test-utils';

const POLICY: ImageCachePolicy = {
  ttlMs: 24 * 60 * 60 * 1000,
  refreshIfOlderThanMs: 18 * 60 * 60 * 1000,
};

interface PutCall {
  key: string;
  value: Uint8Array;
  options?: { expirationTtl?: number; metadata?: { writtenAt: number } };
}

const recordingKv = (initial?: { value: Uint8Array; metadata: { writtenAt: number } | null }): {
  kv: KvNamespace;
  puts: PutCall[];
} => {
  const puts: PutCall[] = [];
  const kv: KvNamespace = {
    getWithMetadata<TMetadata>(_key: string, _type: 'arrayBuffer') {
      if (!initial) return Promise.resolve({ value: null, metadata: null });
      const buffer = initial.value.buffer.slice(initial.value.byteOffset, initial.value.byteOffset + initial.value.byteLength) as ArrayBuffer;
      return Promise.resolve({ value: buffer, metadata: initial.metadata as TMetadata | null });
    },
    put(key, value, options) {
      const view = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array((value as ArrayBufferView).buffer);
      puts.push({ key, value: view, options: options as PutCall['options'] });
      return Promise.resolve();
    },
  };
  return { kv, puts };
};

test('put stamps the entry with the current writtenAt', async () => {
  const { kv, puts } = recordingKv();
  const cache = new KvImageCacheStore(kv, POLICY);

  const before = Date.now();
  await cache.put('k', new Uint8Array([1, 2]));
  const after = Date.now();

  assertEquals(puts.length, 1);
  assertEquals(puts[0].key, 'k');
  assertEquals([...puts[0].value], [1, 2]);
  assertEquals(puts[0].options?.expirationTtl, POLICY.ttlMs / 1000);
  const writtenAt = puts[0].options?.metadata?.writtenAt;
  assert(writtenAt !== undefined && writtenAt >= before && writtenAt <= after);
});

test('get hit younger than the refresh threshold returns bytes without writing', async () => {
  const { kv, puts } = recordingKv({ value: new Uint8Array([7]), metadata: { writtenAt: Date.now() - 1000 } });
  const cache = new KvImageCacheStore(kv, POLICY);

  const hit = await cache.get('k');

  assertEquals([...hit!], [7]);
  assertEquals(puts, []);
});

test('get hit older than the refresh threshold rewrites the entry with a fresh writtenAt', async () => {
  const aged = Date.now() - 20 * 60 * 60 * 1000;
  const { kv, puts } = recordingKv({ value: new Uint8Array([9]), metadata: { writtenAt: aged } });
  const cache = new KvImageCacheStore(kv, POLICY);

  const before = Date.now();
  const hit = await cache.get('k');
  const after = Date.now();

  assertEquals([...hit!], [9]);
  assertEquals(puts.length, 1);
  assertEquals(puts[0].options?.expirationTtl, POLICY.ttlMs / 1000);
  const writtenAt = puts[0].options?.metadata?.writtenAt;
  assert(writtenAt !== undefined && writtenAt >= before && writtenAt <= after);
});

test('get hit on a pre-rework entry without metadata self-heals by stamping a fresh writtenAt', async () => {
  const { kv, puts } = recordingKv({ value: new Uint8Array([3]), metadata: null });
  const cache = new KvImageCacheStore(kv, POLICY);

  const hit = await cache.get('k');

  assertEquals([...hit!], [3]);
  assertEquals(puts.length, 1);
  assert(puts[0].options?.metadata?.writtenAt !== undefined);
});

test('get miss returns null and does not write', async () => {
  const { kv, puts } = recordingKv();
  const cache = new KvImageCacheStore(kv, POLICY);

  const miss = await cache.get('k');

  assertEquals(miss, null);
  assertEquals(puts, []);
});

test('put rounds tiny TTLs up to the KV 60-second floor', async () => {
  const { kv, puts } = recordingKv();
  const cache = new KvImageCacheStore(kv, { ttlMs: 1000, refreshIfOlderThanMs: 500 });

  await cache.put('k', new Uint8Array([1]));

  assertEquals(puts[0].options?.expirationTtl, 60);
});
