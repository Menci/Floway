import { test } from 'vitest';

import { serializeOpenAIImagesEditsJsonPayload, prepareOpenAIImagesEditsBody } from '../src/images.ts';
import { isReplayableBody } from '../src/options.ts';
import { serializeHttpBody, type HttpMultipartBody } from '@floway-dev/http/request-content';
import { assertEquals } from '@floway-dev/test-utils';

const encodedBody = (prepared: Awaited<ReturnType<typeof prepareOpenAIImagesEditsBody>>): Response => {
  const body = serializeHttpBody(prepared.body, prepared.encoding);
  if (!isReplayableBody(body)) throw new Error('Expected replayable request content');
  return new Response(body.open(), {
    headers: prepared.encoding === 'multipart'
      ? { 'content-type': `multipart/form-data; boundary=${(prepared.body as HttpMultipartBody).boundary}` }
      : { 'content-type': 'application/json' },
  });
};
const parseJsonBody = async (prepared: Awaited<ReturnType<typeof prepareOpenAIImagesEditsBody>>): Promise<unknown> => {
  if (prepared.encoding !== 'json') throw new Error('expected a JSON image-edit body');
  return await encodedBody(prepared).json();
};

test('prepareOpenAIImagesEditsBody preserves reference fields and encodes mixed uploads from their bytes', async () => {
  const serialized = await prepareOpenAIImagesEditsBody({
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

test('serializeOpenAIImagesEditsJsonPayload forces upload sources into data URLs', async () => {
  const body = await serializeOpenAIImagesEditsJsonPayload({
    images: [{ type: 'upload', file: { bytes: new TextEncoder().encode('image'), name: 'image.png', type: 'image/png' } }],
    parameters: { prompt: 'edit' },
  }, 'gpt-image-2');
  assertEquals(body, {
    prompt: 'edit',
    images: [{ image_url: 'data:image/png;base64,aW1hZ2U=' }],
    model: 'gpt-image-2',
  });
});

test('prepareOpenAIImagesEditsBody uses the singular field for one upload and the array field for many', async () => {
  const first = { bytes: new TextEncoder().encode('first'), name: 'first.png', type: 'image/png' };
  const second = { bytes: new TextEncoder().encode('second'), name: 'second.png', type: 'image/png' };
  const single = await prepareOpenAIImagesEditsBody({
    images: [{ type: 'upload', file: first }],
    parameters: { prompt: 'single' },
  }, 'gpt-image');
  assertEquals(single.encoding, 'multipart');
  const singleForm = await encodedBody(single).formData();
  assertEquals((singleForm.get('image') as File).name, first.name);
  assertEquals(new Uint8Array(await (singleForm.get('image') as File).arrayBuffer()), first.bytes);
  assertEquals(singleForm.getAll('image[]'), []);

  const multiple = await prepareOpenAIImagesEditsBody({
    images: [{ type: 'upload', file: first }, { type: 'upload', file: second }],
    parameters: { prompt: 'multiple' },
  }, 'gpt-image');
  assertEquals(multiple.encoding, 'multipart');
  const multipleForm = await encodedBody(multiple).formData();
  assertEquals(multipleForm.getAll('image[]').map(value => (value as File).name), [first.name, second.name]);
  assertEquals(await Promise.all(multipleForm.getAll('image[]').map(async value => new Uint8Array(await (value as File).arrayBuffer()))), [first.bytes, second.bytes]);
  assertEquals(multipleForm.get('image'), null);
  assertEquals(multipleForm.get('model'), 'gpt-image');
});

test('prepareOpenAIImagesEditsBody leaves malformed inline data for upstream JSON validation', async () => {
  const serialized = await prepareOpenAIImagesEditsBody({
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

test('prepareOpenAIImagesEditsBody preserves extra inline reference fields through JSON', async () => {
  const serialized = await prepareOpenAIImagesEditsBody({
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
