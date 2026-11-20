import { test } from 'vitest';

import { serializeOpenAIImagesEditsRequest } from '../src/images.ts';
import { assertEquals } from '@floway-dev/test-utils';

const parseJsonBody = async (body: Awaited<ReturnType<typeof serializeOpenAIImagesEditsRequest>>): Promise<unknown> => {
  if (body instanceof FormData) throw new Error('expected a JSON image-edit body');
  return await new Response(body.open()).json();
};

test('serializeOpenAIImagesEditsRequest preserves reference fields and encodes mixed uploads from their bytes', async () => {
  const serialized = await serializeOpenAIImagesEditsRequest({
    images: [
      { type: 'reference', reference: { image_url: 'https://example.test/image.png', detail: 'future-field' } },
      { type: 'upload', file: { bytes: new TextEncoder().encode('inline'), name: 'inline.png', type: 'image/png' } },
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
  const first = { bytes: new TextEncoder().encode('first'), name: 'first.png', type: 'image/png' };
  const second = { bytes: new TextEncoder().encode('second'), name: 'second.png', type: 'image/png' };
  const single = await serializeOpenAIImagesEditsRequest({
    images: [{ type: 'upload', file: first }],
    parameters: { prompt: 'single' },
  }, 'gpt-image');
  assertEquals(single instanceof FormData, true);
  const singleForm = single as FormData;
  assertEquals((singleForm.get('image') as File).name, first.name);
  assertEquals(new Uint8Array(await (singleForm.get('image') as File).arrayBuffer()), first.bytes);
  assertEquals(singleForm.getAll('image[]'), []);

  const multiple = await serializeOpenAIImagesEditsRequest({
    images: [{ type: 'upload', file: first }, { type: 'upload', file: second }],
    parameters: { prompt: 'multiple' },
  }, 'gpt-image');
  assertEquals(multiple instanceof FormData, true);
  const multipleForm = multiple as FormData;
  assertEquals(multipleForm.getAll('image[]').map(value => (value as File).name), [first.name, second.name]);
  assertEquals(await Promise.all(multipleForm.getAll('image[]').map(async value => new Uint8Array(await (value as File).arrayBuffer()))), [first.bytes, second.bytes]);
  assertEquals(multipleForm.get('image'), null);
  assertEquals(multipleForm.get('model'), 'gpt-image');
});
