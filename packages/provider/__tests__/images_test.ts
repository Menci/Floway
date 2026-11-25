import { test } from 'vitest';

import { serializeOpenAIImagesEditsHttpBody, serializeOpenAIImagesEditsRequest } from '../src/images.ts';
import { readUploadedFile } from '../src/multipart.ts';
import { assertEquals } from '@floway-dev/test-utils';

const parseJsonBody = async (body: ReturnType<typeof serializeOpenAIImagesEditsRequest>): Promise<unknown> => {
  if (body instanceof FormData) throw new Error('expected a JSON image-edit body');
  return await new Response(body.open()).json();
};

const readFormFile = async (entry: FormDataEntryValue | null) => {
  if (!(entry instanceof File)) throw new TypeError('Expected a multipart image file');
  return await readUploadedFile(entry);
};

test('serializeOpenAIImagesEditsRequest preserves reference fields and encodes mixed uploads from their bytes', async () => {
  const serialized = serializeOpenAIImagesEditsRequest({
    images: [
      { type: 'reference', reference: { image_url: 'https://example.test/image.png', detail: 'future-field' } },
      { type: 'upload', file: { name: 'inline.png', type: 'image/png', bytes: new TextEncoder().encode('inline') } },
    ],
    mask: { type: 'reference', reference: { file_id: 'file-mask' } },
    parameters: { prompt: 'edit', background: null },
  }, 'gpt-image');
  const body = await parseJsonBody(serialized);
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
  const first = { name: 'first.png', type: 'image/png', bytes: new TextEncoder().encode('first') };
  const second = { name: 'second.png', type: 'image/png', bytes: new TextEncoder().encode('second') };
  const single = serializeOpenAIImagesEditsRequest({
    images: [{ type: 'upload', file: first }],
    parameters: { prompt: 'single' },
  }, 'gpt-image');
  assertEquals(single instanceof FormData, true);
  const singleForm = single as FormData;
  assertEquals(await readFormFile(singleForm.get('image')), first);
  assertEquals(singleForm.getAll('image[]'), []);

  const multiple = serializeOpenAIImagesEditsRequest({
    images: [{ type: 'upload', file: first }, { type: 'upload', file: second }],
    parameters: { prompt: 'multiple' },
  }, 'gpt-image');
  assertEquals(multiple instanceof FormData, true);
  const multipleForm = multiple as FormData;
  assertEquals(await Promise.all(multipleForm.getAll('image[]').map(readFormFile)), [first, second]);
  assertEquals(multipleForm.get('image'), null);
  assertEquals(multipleForm.get('model'), 'gpt-image');
});

test('serializeOpenAIImagesEditsHttpBody pairs multipart bytes with the matching boundary', async () => {
  const file = { name: 'sample.png', type: 'image/png', bytes: Uint8Array.of(0xff, 0x00) };
  const { body, contentType } = await serializeOpenAIImagesEditsHttpBody({
    images: [{ type: 'upload', file }], parameters: { prompt: 'edit' },
  }, 'gpt-image');
  const form = await new Response(body, { headers: { 'content-type': contentType } }).formData();
  assertEquals(await readFormFile(form.get('image')), file);
  assertEquals(form.get('model'), 'gpt-image');
});

test('serializeOpenAIImagesEditsHttpBody retains JSON image references', async () => {
  const reference = { file_id: 'image-file' };
  const { body, contentType } = await serializeOpenAIImagesEditsHttpBody({
    images: [{ type: 'reference', reference }], parameters: { prompt: 'edit' },
  }, 'gpt-image');

  assertEquals(contentType, 'application/json');
  assertEquals(await new Response(body).json(), { images: [reference], model: 'gpt-image', prompt: 'edit' });
});
