import { expect, test } from 'vitest';

import { serializeOpenAIImagesEditsRequest } from '../src/images.ts';
import { Bytes } from '@floway-dev/pipeline';

const first = { type: 'upload', bytes: Bytes.fromUtf8('first'), filename: 'first.png', contentType: 'image/png' } as const;
const second = { type: 'inline', reference: { image_url: 'data:image/png;base64,c2Vjb25k' } } as const;

test('preserves reference fields and encodes mixed image uploads from their bytes', () => {
  const serialized = serializeOpenAIImagesEditsRequest({
    images: [
      { type: 'reference', reference: { image_url: 'https://example.test/image.png', detail: 'future-field' } },
      first,
    ],
    mask: { type: 'reference', reference: { file_id: 'file-mask' } },
    parameters: { prompt: 'edit', background: null },
  }, 'gpt-image');
  expect(serialized).toEqual({
    kind: 'json',
    value: {
      prompt: 'edit',
      background: null,
      images: [
        { image_url: 'https://example.test/image.png', detail: 'future-field' },
        { image_url: 'data:image/png;base64,Zmlyc3Q=' },
      ],
      mask: { file_id: 'file-mask' },
      model: 'gpt-image',
    },
  });
});

test('uses the singular field for one upload and repeated array fields for multiple uploads', () => {
  const single = serializeOpenAIImagesEditsRequest({ images: [first], parameters: {} }, 'gpt-image');
  expect(single).toMatchObject({ kind: 'multipart', parts: [{ name: 'image', filename: 'first.png' }, { name: 'model', value: 'gpt-image' }] });
  const multiple = serializeOpenAIImagesEditsRequest({ images: [first, second], mask: first, parameters: { prompt: 'edit' } }, 'gpt-image');
  expect(multiple).toMatchObject({
    kind: 'multipart',
    parts: [
      { name: 'prompt', value: 'edit' },
      { name: 'image[]', filename: 'first.png' },
      { name: 'image[]', filename: 'image-1' },
      { name: 'mask', filename: 'first.png' },
      { name: 'model', value: 'gpt-image' },
    ],
  });
  if (multiple.kind !== 'multipart') throw new Error('Expected multipart body');
  const inline = multiple.parts[2];
  if (inline.kind !== 'file') throw new Error('Expected inline image file');
  expect(inline.bytes.utf8()).toBe('second');
});

test('keeps invalid base64 and inline references with extra fields in JSON', () => {
  for (const reference of [
    { image_url: 'data:image/png;base64,%%%%' },
    { image_url: 'data:image/png;base64,c2Vjb25k', detail: 'future-field' },
  ]) {
    expect(serializeOpenAIImagesEditsRequest({ images: [{ type: 'inline', reference }], parameters: {} }, 'gpt-image')).toEqual({
      kind: 'json',
      value: { images: [reference], model: 'gpt-image' },
    });
  }
});
