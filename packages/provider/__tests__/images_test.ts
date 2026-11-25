import { expect, test } from 'vitest';

import { serializeOpenAIImagesEditsBody, serializeOpenAIImagesEditsJsonBody, serializeOpenAIImagesEditsRequest } from '../src/images.ts';
import type { OpenAIImagesEditsPayload } from '../src/pipeline-facts.ts';
import { assertEquals } from '@floway-dev/test-utils';

const parseJsonBody = async (body: Awaited<ReturnType<typeof serializeOpenAIImagesEditsRequest>>): Promise<unknown> => {
  if (body instanceof FormData) throw new Error('expected a JSON image-edit body');
  return await new Response(body.open()).json();
};

test('serializeOpenAIImagesEditsRequest preserves reference fields and encodes mixed uploads from their bytes', async () => {
  const serialized = await serializeOpenAIImagesEditsRequest({
    images: [
      { type: 'reference', reference: { image_url: 'https://example.test/image.png', detail: 'future-field' } },
      { type: 'upload', file: new File(['inline'], 'inline.png', { type: 'image/png' }) },
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
  const first = new File(['first'], 'first.png', { type: 'image/png' });
  const second = new File(['second'], 'second.png', { type: 'image/png' });
  const single = await serializeOpenAIImagesEditsRequest({
    images: [{ type: 'upload', file: first }],
    parameters: { prompt: 'single' },
  }, 'gpt-image');
  assertEquals(single instanceof FormData, true);
  const singleForm = single as FormData;
  assertEquals(singleForm.get('image'), first);
  assertEquals(singleForm.getAll('image[]'), []);

  const multiple = await serializeOpenAIImagesEditsRequest({
    images: [{ type: 'upload', file: first }, { type: 'upload', file: second }],
    parameters: { prompt: 'multiple' },
  }, 'gpt-image');
  assertEquals(multiple instanceof FormData, true);
  const multipleForm = multiple as FormData;
  assertEquals(multipleForm.getAll('image[]'), [first, second]);
  assertEquals(multipleForm.get('image'), null);
  assertEquals(multipleForm.get('model'), 'gpt-image');
});

const upload = (name: string, mediaType: string, data: string): OpenAIImagesEditsPayload['images'][number] => ({
  type: 'upload', file: { name, mediaType, bytes: new TextEncoder().encode(data) },
});

test('byte image edits preserve repeated multipart file names, types and data', async () => {
  const { body, contentType } = await serializeOpenAIImagesEditsBody({
    images: [upload('first.png', 'image/png', 'first'), upload('second.webp', 'image/webp', 'second')],
    mask: upload('mask.png', 'image/png', 'mask'),
    parameters: { prompt: 'edit', n: 1 },
  }, 'gpt-image');
  expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
  const form = await new Response(body, { headers: { 'content-type': contentType } }).formData();
  const files = [...form.getAll('image[]'), form.get('mask')];
  const actual = await Promise.all(files.map(async file => {
    if (!(file instanceof File)) throw new Error('Expected a multipart file');
    return [file.name, file.type, await file.text()];
  }));
  expect(actual).toEqual([['first.png', 'image/png', 'first'], ['second.webp', 'image/webp', 'second'], ['mask.png', 'image/png', 'mask']]);
  expect(form.get('model')).toBe('gpt-image');
  expect(form.get('prompt')).toBe('edit');
  expect(form.get('n')).toBe('1');
});

test('byte image edits keep incompatible parameters and reference fields on the JSON path', async () => {
  const request: OpenAIImagesEditsPayload = {
    images: [upload('first.png', 'image/png', 'first'), { type: 'reference', reference: { image_url: 'https://example.test/a.png', detail: 'forwarded' } }],
    parameters: { prompt: 'edit', background: null },
  };
  const { body, contentType } = await serializeOpenAIImagesEditsBody(request, 'gpt-image');
  expect(contentType).toBe('application/json');
  expect(JSON.parse(new TextDecoder().decode(body))).toEqual({
    prompt: 'edit', background: null, model: 'gpt-image',
    images: [{ image_url: 'data:image/png;base64,Zmlyc3Q=' }, { image_url: 'https://example.test/a.png', detail: 'forwarded' }],
  });
});

test('the byte-aware JSON sibling can force upload-only edits to JSON', async () => {
  const { body, contentType } = await serializeOpenAIImagesEditsJsonBody({
    images: [upload('first.png', 'image/png', 'first')], parameters: {},
  }, 'gpt-image');
  expect(contentType).toBe('application/json');
  expect(JSON.parse(new TextDecoder().decode(body))).toEqual({ model: 'gpt-image', images: [{ image_url: 'data:image/png;base64,Zmlyc3Q=' }] });
});
