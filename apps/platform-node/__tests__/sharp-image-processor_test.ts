import sharp from 'sharp';
import { test } from 'vitest';

import { createSharpImageProcessor } from '../src/sharp-image-processor.ts';
import type { ImageCacheStore } from '@floway-dev/platform';
import { initImageCacheStore } from '@floway-dev/platform';
import { assertEquals } from '@floway-dev/test-utils';

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
