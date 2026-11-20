import { expect, test } from 'vitest';

import { parseBase64ImageDataUrl } from '../src/image-helpers.ts';

test('parseBase64ImageDataUrl normalizes valid image media types', () => {
  expect(parseBase64ImageDataUrl('data:IMAGE/PNG;charset=binary;base64,AQID')).toEqual({
    mimeType: 'image/png',
    base64: 'AQID',
  });
});

test('parseBase64ImageDataUrl rejects media type near matches', () => {
  expect(parseBase64ImageDataUrl('data:imager/png;base64,AQID')).toBeNull();
});
