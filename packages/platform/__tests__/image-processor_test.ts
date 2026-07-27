import { test } from 'vitest';

import {
  compressBytesToWebp,
  dimensionsFromBytes,
  fitWithin,
  type ImageDimensions,
  type ImageProcessor,
  initImageProcessor,
} from '../src/image-processor.ts';
import { assert, assertEquals } from '@floway-dev/test-utils';

const decode = (base64: string): Uint8Array => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

// Real 1×1 PNG, JPEG, and WebP byte fixtures generated offline. Each carries
// the canonical magic bytes plus a minimal header so image-size's parser can
// read width/height without decoding pixel data.
const PNG_1x1 = decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/wEAAAAASUVORK5CYII=');
const JPEG_1x1 = decode('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAr/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AL+AB//Z');
// 1x1 lossless WebP: RIFF...WEBPVP8L...
const WEBP_1x1 = decode('UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAEAcQERGIiP4HAA==');

test('dimensionsFromBytes reads PNG dimensions from the header', () => {
  assertEquals(dimensionsFromBytes(PNG_1x1), { width: 1, height: 1 });
});

test('dimensionsFromBytes reads JPEG dimensions from the header', () => {
  assertEquals(dimensionsFromBytes(JPEG_1x1), { width: 1, height: 1 });
});

test('dimensionsFromBytes reads WebP dimensions from the header', () => {
  assertEquals(dimensionsFromBytes(WEBP_1x1), { width: 1, height: 1 });
});

test('dimensionsFromBytes returns null on unparseable bytes', () => {
  assertEquals(dimensionsFromBytes(new Uint8Array([1, 2, 3, 4])), null);
});

test('dimensionsFromBytes returns null on an empty buffer', () => {
  assertEquals(dimensionsFromBytes(new Uint8Array()), null);
});

test('fitWithin passes the source through when no caps are set', () => {
  assertEquals(fitWithin({ width: 1000, height: 500 }, {}), { width: 1000, height: 500 });
});

test('fitWithin clamps the long edge while preserving aspect ratio', () => {
  assertEquals(fitWithin({ width: 4000, height: 1000 }, { maxLongEdge: 2048 }), { width: 2048, height: 512 });
});

test('fitWithin clamps the short edge while preserving aspect ratio', () => {
  assertEquals(fitWithin({ width: 4000, height: 2000 }, { maxShortEdge: 768 }), { width: 1536, height: 768 });
});

test('fitWithin clamps to the area cap', () => {
  // 2000x2000 = 4MP -> 2.56MP -> sqrt(2.56/4) = 0.8 -> 1600x1600.
  assertEquals(fitWithin({ width: 2000, height: 2000 }, { maxArea: 2_560_000 }), { width: 1600, height: 1600 });
});

test('fitWithin picks the most restrictive of multiple caps', () => {
  // long-edge cap to 2048 -> 2048x1024; short-edge cap 768 -> 1536x768.
  // Short edge wins.
  assertEquals(
    fitWithin({ width: 4000, height: 2000 }, { maxLongEdge: 2048, maxShortEdge: 768 }),
    { width: 1536, height: 768 },
  );
});

test('fitWithin never enlarges past the source', () => {
  assertEquals(fitWithin({ width: 100, height: 100 }, { maxLongEdge: 4096 }), { width: 100, height: 100 });
});

test('compressBytesToWebp reads source dimensions, runs the calculator, and forwards the resolved target', async () => {
  const calls: { input: Uint8Array; target: ImageDimensions | null }[] = [];
  const processor: ImageProcessor = {
    compressToWebp(input, target) {
      calls.push({ input, target });
      return Promise.resolve(new Uint8Array([42]));
    },
  };
  initImageProcessor(processor);

  const calculatorCalls: ImageDimensions[] = [];
  const calculator = (source: ImageDimensions): ImageDimensions => {
    calculatorCalls.push(source);
    return { width: source.width * 2, height: source.height * 3 };
  };

  const out = await compressBytesToWebp(PNG_1x1, calculator);

  assertEquals([...out], [42]);
  assertEquals(calculatorCalls, [{ width: 1, height: 1 }]);
  assertEquals(calls.length, 1);
  assert(calls[0].input === PNG_1x1);
  assertEquals(calls[0].target, { width: 2, height: 3 });
});

test('compressBytesToWebp forwards null target when source dimensions cannot be read', async () => {
  let calculatorCalled = false;
  const calls: { target: ImageDimensions | null }[] = [];
  const processor: ImageProcessor = {
    compressToWebp(_input, target) {
      calls.push({ target });
      return Promise.resolve(new Uint8Array([7]));
    },
  };
  initImageProcessor(processor);

  const out = await compressBytesToWebp(new Uint8Array([1, 2, 3, 4]), () => {
    calculatorCalled = true;
    return { width: 99, height: 99 };
  });

  assertEquals([...out], [7]);
  assertEquals(calculatorCalled, false);
  assertEquals(calls, [{ target: null }]);
});
