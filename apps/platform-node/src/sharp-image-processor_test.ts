import sharp from 'sharp';
import { test } from 'vitest';

import { createSharpImageProcessor } from './sharp-image-processor.ts';
import type { ImageCacheStore } from '@floway-dev/platform';
import { initImageCacheStore } from '@floway-dev/platform';
import { assert, assertEquals } from '@floway-dev/test-utils';

const decode = (base64: string): Uint8Array => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

// 1x1 red PNG. Used everywhere we don't care about input dimensions; sharp
// can decode it but it's too small to exercise the resize path.
const PNG_1x1 = decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4z8AAAAMBAQCc479ZAAAAAElFTkSuQmCC');

const generatePng = async (width: number, height: number): Promise<Uint8Array> => {
  const buffer = await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 200, g: 100, b: 50 },
    },
  }).png().toBuffer();
  return new Uint8Array(buffer);
};

const isWebp = (bytes: Uint8Array): boolean =>
  bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;

const installMemoryStore = (): Map<string, Uint8Array> => {
  const store = new Map<string, Uint8Array>();
  const cacheStore: ImageCacheStore = {
    get(key) {
      return Promise.resolve(store.get(key) ?? null);
    },
    put(key, value) {
      store.set(key, value);
      return Promise.resolve();
    },
    sweepExpired() {
      return Promise.resolve();
    },
  };
  initImageCacheStore(cacheStore);
  return store;
};

test('compressToWebp produces valid WebP magic bytes', async () => {
  installMemoryStore();
  const processor = createSharpImageProcessor();
  const out = await processor.compressToWebp(PNG_1x1, null);
  assert(isWebp(out), 'output should be WebP');
});

test('compressToWebp resizes to target dimensions', async () => {
  installMemoryStore();
  const processor = createSharpImageProcessor();
  const source = await generatePng(200, 100);
  const out = await processor.compressToWebp(source, { width: 50, height: 50 });
  const meta = await sharp(out).metadata();
  // fit:'inside' preserves aspect ratio: 200x100 → 50x25.
  assertEquals(meta.width, 50);
  assertEquals(meta.height, 25);
});

test('compressToWebp with target=null preserves source dimensions', async () => {
  installMemoryStore();
  const processor = createSharpImageProcessor();
  const source = await generatePng(80, 40);
  const out = await processor.compressToWebp(source, null);
  const meta = await sharp(out).metadata();
  assertEquals(meta.width, 80);
  assertEquals(meta.height, 40);
});

test('compressToWebp never enlarges past the source', async () => {
  installMemoryStore();
  const processor = createSharpImageProcessor();
  const source = await generatePng(40, 20);
  const out = await processor.compressToWebp(source, { width: 4096, height: 4096 });
  const meta = await sharp(out).metadata();
  assertEquals(meta.width, 40);
  assertEquals(meta.height, 20);
});

test('cache hit short-circuits encode and returns stored bytes', async () => {
  const calls = { get: 0, put: 0 };
  const stored = new Uint8Array([0x42, 0x42, 0x42]);
  const cacheStore: ImageCacheStore = {
    get: () => {
      calls.get += 1;
      return Promise.resolve(stored);
    },
    put: () => {
      calls.put += 1;
      return Promise.resolve();
    },
    sweepExpired: () => Promise.resolve(),
  };
  initImageCacheStore(cacheStore);
  const processor = createSharpImageProcessor();
  const out = await processor.compressToWebp(PNG_1x1, null);
  assertEquals(out, stored);
  assertEquals(calls.get, 1);
  assertEquals(calls.put, 0);
});

test('cache miss writes the encoded result through the cache store', async () => {
  const calls = { get: 0, put: 0 };
  const cacheStore: ImageCacheStore = {
    get: () => {
      calls.get += 1;
      return Promise.resolve(null);
    },
    put: () => {
      calls.put += 1;
      return Promise.resolve();
    },
    sweepExpired: () => Promise.resolve(),
  };
  initImageCacheStore(cacheStore);
  const processor = createSharpImageProcessor();
  const out = await processor.compressToWebp(PNG_1x1, null);
  assert(isWebp(out), 'output should be WebP');
  assertEquals(calls.get, 1);
  assertEquals(calls.put, 1);
});

test('cache key differs by target so a resized variant is a separate entry', async () => {
  installMemoryStore();
  const processor = createSharpImageProcessor();
  const source = await generatePng(40, 20);
  const orig = await processor.compressToWebp(source, null);
  const resized = await processor.compressToWebp(source, { width: 20, height: 20 });
  // Same backing source bytes but different target boxes — outputs must differ.
  assert(orig.length !== resized.length || !orig.every((b, i) => b === resized[i]));
});
