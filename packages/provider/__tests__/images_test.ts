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

test('serializeOpenAIImagesEditsRequest leaves malformed inline data for upstream JSON validation', async () => {
  const serialized = await serializeOpenAIImagesEditsRequest({
    images: [{
      type: 'inline',
      reference: { image_url: 'data:image/png;base64,%%%' },
    }],
    parameters: { prompt: 'edit' },
  }, 'gpt-image');
  assertEquals(await parseJsonBody(serialized), {
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
  assertEquals(await parseJsonBody(serialized), {
    prompt: 'edit',
    images: [{ image_url: 'data:image/png;base64,aW1hZ2U=', future_field: 'keep' }],
    model: 'gpt-image',
  });
});
