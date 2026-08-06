import { test } from 'vitest';

import { serializeOpenAIImagesEditsRequest } from '../src/images.ts';
import { replayableBodySource } from '../src/replayable-body.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('serializeOpenAIImagesEditsRequest preserves reference fields and encodes mixed uploads from their bytes', async () => {
  const serialized = await serializeOpenAIImagesEditsRequest({
    images: [
      { type: 'reference', reference: { image_url: 'https://example.test/image.png', detail: 'future-field' } },
      { type: 'upload', file: new File(['inline'], 'inline.png', { type: 'image/png' }) },
    ],
    mask: { type: 'reference', reference: { file_id: 'file-mask' } },
    parameters: { prompt: 'edit', background: null },
  }, 'gpt-image');
  assertEquals(typeof serialized.body, 'string');
  const body = JSON.parse(serialized.body as string) as Record<string, unknown>;
  assertEquals(body, {
    prompt: 'edit',
    background: null,
    images: [
      { image_url: 'https://example.test/image.png', detail: 'future-field' },
      { image_url: 'data:image/png;base64,aW5saW5l' },
    ],
    mask: { file_id: 'file-mask' },
    model: 'gpt-image',
  });
});

test('serializeOpenAIImagesEditsRequest uses the singular field for one upload and the array field for many', async () => {
  const first = new File(['first'], 'first.png', { type: 'image/png' });
  const second = new File(['second'], 'second.png', { type: 'image/png' });
  const single = await serializeOpenAIImagesEditsRequest({
    images: [{ type: 'upload', file: first }],
    parameters: { prompt: 'single' },
  }, 'gpt-image');
  const singleForm = await new Response(single.body, { headers: { 'content-type': single.contentType } }).formData();
  const singleImage = singleForm.get('image');
  if (!(singleImage instanceof File)) throw new Error('expected single image file');
  assertEquals(singleImage.name, first.name);
  assertEquals(await singleImage.text(), await first.text());
  assertEquals(singleForm.getAll('image[]'), []);

  const multiple = await serializeOpenAIImagesEditsRequest({
    images: [{ type: 'upload', file: first }, { type: 'upload', file: second }],
    parameters: { prompt: 'multiple' },
  }, 'gpt-image');
  const multipleForm = await new Response(multiple.body, { headers: { 'content-type': multiple.contentType } }).formData();
  const multipleImages = multipleForm.getAll('image[]');
  assertEquals(multipleImages.map(image => image instanceof File ? image.name : null), [first.name, second.name]);
  assertEquals(multipleForm.get('image'), null);
  assertEquals(multipleForm.get('model'), 'gpt-image');
});

test('serializeOpenAIImagesEditsRequest leaves malformed inline data for upstream JSON validation', async () => {
  const serialized = await serializeOpenAIImagesEditsRequest({
    images: [{
      type: 'inline',
      reference: { image_url: 'data:image/png;base64,%%%' },
    }],
    parameters: { prompt: 'edit' },
  }, 'gpt-image');
  assertEquals(typeof serialized.body, 'string');
  assertEquals(JSON.parse(serialized.body as string), {
    prompt: 'edit',
    images: [{ image_url: 'data:image/png;base64,%%%' }],
    model: 'gpt-image',
  });
});

test('serializeOpenAIImagesEditsRequest preserves extra inline reference fields through JSON', async () => {
  const serialized = await serializeOpenAIImagesEditsRequest({
    images: [{
      type: 'inline',
      reference: { image_url: 'data:image/png;base64,aW1hZ2U=', future_field: 'keep' },
    }],
    parameters: { prompt: 'edit' },
  }, 'gpt-image');
  assertEquals(typeof serialized.body, 'string');
  assertEquals(JSON.parse(serialized.body as string), {
    prompt: 'edit',
    images: [{ image_url: 'data:image/png;base64,aW1hZ2U=', future_field: 'keep' }],
    model: 'gpt-image',
  });
});

test('serializeOpenAIImagesEditsRequest retains raw upload byte views as replayable segments', async () => {
  const backing = Uint8Array.of(99, 1, 2, 3, 99);
  const bytes = backing.subarray(1, 4);
  const serialized = await serializeOpenAIImagesEditsRequest({
    images: [{ type: 'raw-upload', upload: { name: 'raw.png', type: 'image/png', bytes } }],
    parameters: { prompt: 'edit' },
  }, 'gpt-image');

  const source = replayableBodySource(serialized.body);
  if (source === null) throw new Error('expected replayable multipart body');
  assertEquals(source.segments.includes(bytes), true);
  const form = await new Response(serialized.body, { headers: { 'content-type': serialized.contentType } }).formData();
  const file = form.get('image');
  if (!(file instanceof File)) throw new Error('expected image file');
  assertEquals(Array.from(new Uint8Array(await file.arrayBuffer())), [1, 2, 3]);
});
