import { expect, test } from 'vitest';

import { base64ToBytes, bytesToBase64, parseBase64ImageDataUrl } from '../src/image-helpers.ts';

test('base64 helpers preserve external whitespace, omitted padding, and byte values', () => {
  expect(base64ToBytes(' AQID\nBA\t')).toEqual(new Uint8Array([1, 2, 3, 4]));
  const bytes = new Uint8Array([0, 1, 127, 128, 254, 255]);
  expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
});

test('base64 helpers preserve forgiving trailing-bit acceptance', () => {
  expect(new TextDecoder().decode(base64ToBytes('Zh=='))).toBe('f');
  expect(() => base64ToBytes('Zg=')).toThrow();
});

test('parseBase64ImageDataUrl normalizes valid image media types', () => {
  expect(parseBase64ImageDataUrl('data:IMAGE/PNG;charset=binary;base64,AQID')).toEqual({
    mimeType: 'image/png',
    base64: 'AQID',
  });
});

test('parseBase64ImageDataUrl rejects media type near matches', () => {
  expect(parseBase64ImageDataUrl('data:imager/png;base64,AQID')).toBeNull();
});
