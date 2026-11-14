import { describe, expect, test } from 'vitest';

import { parseOpenAIImagesEditsRequest, parseOpenAIImagesGenerationsRequest } from '../../src/openai-images/request.ts';

const json = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

const multipart = async (form: FormData): Promise<{ contentType: string; bytes: Uint8Array }> => {
  const encoded = new Response(form);
  return {
    contentType: encoded.headers.get('content-type')!,
    bytes: new Uint8Array(await encoded.arrayBuffer()),
  };
};

describe('OpenAI Images Generations ingress', () => {
  test('routing takes the model and everything else stays as the client wrote it', () => {
    const parsed = parseOpenAIImagesGenerationsRequest(json({
      model: 'gpt-image-1',
      prompt: 'a shiba in space',
      size: '1024x1024',
      moderation: 'low',
    }));

    expect(parsed.model).toBe('gpt-image-1');
    expect(parsed.request).toEqual({
      operation: 'generations',
      parameters: { prompt: 'a shiba in space', size: '1024x1024', moderation: 'low' },
    });
  });

  test('a body that is not a JSON object, or names no model, is refused with what to fix', () => {
    expect(() => parseOpenAIImagesGenerationsRequest(new TextEncoder().encode('not json')))
      .toThrow('OpenAI Images Generations request body must be valid JSON.');
    expect(() => parseOpenAIImagesGenerationsRequest(json(['gpt-image-1'])))
      .toThrow('OpenAI Images Generations request body must be an object.');
    expect(() => parseOpenAIImagesGenerationsRequest(json({ prompt: 'hi' })))
      .toThrow('OpenAI Images Generations request body must include a model string.');
  });
});

describe('OpenAI Images Edits ingress', () => {
  test('a JSON edit keeps each reference exactly as it arrived', async () => {
    const parsed = await parseOpenAIImagesEditsRequest('application/json', json({
      model: 'gpt-image-1',
      prompt: 'replace the background',
      images: [{ image_url: 'data:image/png;base64,iVBORw0KGgo=' }, { file_id: 'file-source' }],
      mask: { file_id: 'file-mask' },
      quality: 'high',
    }));

    expect(parsed.model).toBe('gpt-image-1');
    expect(parsed.request).toEqual({
      operation: 'edits',
      images: [
        { kind: 'reference', reference: { image_url: 'data:image/png;base64,iVBORw0KGgo=' } },
        { kind: 'reference', reference: { file_id: 'file-source' } },
      ],
      mask: { kind: 'reference', reference: { file_id: 'file-mask' } },
      parameters: { prompt: 'replace the background', quality: 'high' },
    });
  });

  test('a reference naming both ways, or neither, is refused by position', async () => {
    await expect(parseOpenAIImagesEditsRequest('application/json', json({
      model: 'gpt-image-1',
      images: [{ file_id: 'file-source' }, { image_url: 'https://example.com/a.png', file_id: 'file-source' }],
    }))).rejects.toThrow('OpenAI Images Edits images[1] must contain exactly one string field: image_url or file_id.');

    await expect(parseOpenAIImagesEditsRequest('application/json', json({ model: 'gpt-image-1', prompt: 'hi' })))
      .rejects.toThrow('OpenAI Images Edits request body must include an images array.');
  });

  test('a multipart edit holds each file as bytes and every other field as text', async () => {
    const form = new FormData();
    form.append('model', 'gpt-image-1');
    form.append('prompt', 'replace the sky');
    form.append('n', '2');
    form.append('image[]', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'photo.png');
    form.append('image[]', new Blob([new Uint8Array([4, 5])], { type: 'image/webp' }), 'second.webp');
    form.append('mask', new Blob([new Uint8Array([6])], { type: 'image/png' }), 'mask.png');
    const { contentType, bytes } = await multipart(form);

    const parsed = await parseOpenAIImagesEditsRequest(contentType, bytes);

    expect(parsed.model).toBe('gpt-image-1');
    expect(parsed.request).toEqual({
      operation: 'edits',
      images: [
        { kind: 'file', file: { fileName: 'photo.png', mediaType: 'image/png', bytes: new Uint8Array([1, 2, 3]) } },
        { kind: 'file', file: { fileName: 'second.webp', mediaType: 'image/webp', bytes: new Uint8Array([4, 5]) } },
      ],
      mask: { kind: 'file', file: { fileName: 'mask.png', mediaType: 'image/png', bytes: new Uint8Array([6]) } },
      // A form field is text, so `n` stays the string the client sent it as.
      parameters: { prompt: 'replace the sky', n: '2' },
    });
  });

  test('a multipart edit naming no model is refused before its fields are read', async () => {
    const form = new FormData();
    form.append('prompt', 'replace the sky');
    const { contentType, bytes } = await multipart(form);

    await expect(parseOpenAIImagesEditsRequest(contentType, bytes))
      .rejects.toThrow('OpenAI Images Edits request body must include a model field.');
  });

  test('an image field carrying text, and a text field carrying a file, are both refused', async () => {
    const textImage = new FormData();
    textImage.append('model', 'gpt-image-1');
    textImage.append('image', 'not a file');
    const encodedTextImage = await multipart(textImage);
    await expect(parseOpenAIImagesEditsRequest(encodedTextImage.contentType, encodedTextImage.bytes))
      .rejects.toThrow('OpenAI Images Edits image fields must be files.');

    const fileParameter = new FormData();
    fileParameter.append('model', 'gpt-image-1');
    fileParameter.append('prompt', new Blob([new Uint8Array([1])], { type: 'text/plain' }), 'prompt.txt');
    const encodedFileParameter = await multipart(fileParameter);
    await expect(parseOpenAIImagesEditsRequest(encodedFileParameter.contentType, encodedFileParameter.bytes))
      .rejects.toThrow('OpenAI Images Edits prompt field must be text.');
  });

  test('a body in neither of the two media types the endpoint takes is refused as such', async () => {
    await expect(parseOpenAIImagesEditsRequest('text/plain', new TextEncoder().encode('hi')))
      .rejects.toThrow('OpenAI Images Edits request body must use application/json or multipart/form-data.');
    await expect(parseOpenAIImagesEditsRequest(undefined, new TextEncoder().encode('hi')))
      .rejects.toThrow('OpenAI Images Edits request body must use application/json or multipart/form-data.');
  });
});
