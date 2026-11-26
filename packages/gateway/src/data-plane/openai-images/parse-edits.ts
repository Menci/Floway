import { openaiImagesError } from './parse-generations.ts';
import { jsonResponse, localResponseHead } from '../pipeline/encode.ts';
import { defineStage } from '../pipeline/facts.ts';
import { prepareJsonModelRequest } from '../shared/json-model-request.ts';
import { getHeader } from '@floway-dev/http';
import { isJsonMediaType, isMultipartFormDataMediaType } from '@floway-dev/protocols/common';
import type { OpenAIImageEditReference } from '@floway-dev/protocols/openai-images';
import { isBase64ImageDataUrl, type MultipartFile, type OpenAIImagesEditsPayload } from '@floway-dev/provider';

type Source = OpenAIImagesEditsPayload['images'][number];
type PreparedEdit =
  | { type: 'ok'; model: string; payload: OpenAIImagesEditsPayload }
  | { type: 'invalid'; message: string };

const invalid = (message: string): PreparedEdit => ({ type: 'invalid', message });

export const parseOpenAIImagesEdits = defineStage({
  name: 'openaiImagesEdits.parse',
  through: {
    request: { needs: ['request.http'], provides: ['request.openaiImagesEdits', 'request.model'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  return: { provides: ['response.http', 'response.outcome'] },
  async execute(facts, scope) {
    const { body, headers } = facts['request.http'];
    const mediaType = getHeader(headers, 'content-type');
    const parsed = await prepareOpenAIImagesEdits(body ?? new Uint8Array(), typeof mediaType === 'string' ? mediaType : undefined);
    if (parsed.type === 'invalid') {
      return {
        'response.http': jsonResponse(localResponseHead(400), openaiImagesError(parsed.message)),
        'response.outcome': scope.createDeferred(async () => 'local' as const),
      };
    }
    return await scope.next({ ...facts, 'request.model': parsed.model, 'request.openaiImagesEdits': parsed.payload });
  },
});

const imageSource = (value: unknown, path: string): Source | string => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return `${path} must be an object.`;
  }
  const { image_url: imageUrl, file_id: fileId } = value as { image_url?: unknown; file_id?: unknown };
  if (typeof imageUrl === 'string' && fileId === undefined) {
    const reference = value as OpenAIImageEditReference & { image_url: string };
    return isBase64ImageDataUrl(imageUrl) ? { type: 'inline', reference } : { type: 'reference', reference };
  }
  if (typeof fileId === 'string' && imageUrl === undefined) {
    return { type: 'reference', reference: value as OpenAIImageEditReference };
  }
  return `${path} must contain exactly one string field: image_url or file_id.`;
};

const prepareJsonEdit = (bytes: Uint8Array): PreparedEdit => {
  const prepared = prepareJsonModelRequest(bytes, 'OpenAI Images Edits');
  if (prepared.type === 'invalid') return prepared;
  const { model: _model, images: values, mask: maskValue, ...parameters } = prepared.body;
  if (!Array.isArray(values)) return invalid('OpenAI Images Edits request body must include an images array.');

  const images: Source[] = [];
  for (const [index, value] of values.entries()) {
    const source = imageSource(value, `OpenAI Images Edits images[${index}]`);
    if (typeof source === 'string') return invalid(source);
    images.push(source);
  }
  const mask = maskValue === undefined ? undefined : imageSource(maskValue, 'OpenAI Images Edits mask');
  if (typeof mask === 'string') return invalid(mask);
  return {
    type: 'ok',
    model: prepared.model,
    payload: { images, ...(mask === undefined ? {} : { mask }), parameters },
  };
};

const uploadedFile = async (file: File): Promise<MultipartFile> => ({
  name: file.name,
  mediaType: file.type,
  bytes: new Uint8Array(await file.arrayBuffer()),
});

const prepareMultipartEdit = async (bytes: Uint8Array, contentType: string): Promise<PreparedEdit> => {
  let form: FormData;
  try {
    form = await new Response(bytes as BodyInit, { headers: { 'content-type': contentType } }).formData();
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return invalid('OpenAI Images Edits request body must be valid multipart/form-data.');
  }
  const model = form.get('model');
  if (typeof model !== 'string' || model.length === 0) {
    return invalid('OpenAI Images Edits request body must include a model field.');
  }
  const images: Source[] = [];
  let mask: Source | undefined;
  const parameters: Record<string, string> = {};
  for (const [name, value] of form.entries()) {
    if (name === 'model') continue;
    if (name === 'image' || name === 'image[]') {
      if (!(value instanceof File)) return invalid(`OpenAI Images Edits ${name} fields must be files.`);
      images.push({ type: 'upload', file: await uploadedFile(value) });
    } else if (name === 'mask') {
      if (!(value instanceof File)) return invalid('OpenAI Images Edits mask field must be a file.');
      mask = { type: 'upload', file: await uploadedFile(value) };
    } else {
      if (typeof value !== 'string') return invalid(`OpenAI Images Edits ${name} field must be text.`);
      parameters[name] = value;
    }
  }
  return { type: 'ok', model, payload: { images, ...(mask === undefined ? {} : { mask }), parameters } };
};

const prepareOpenAIImagesEdits = async (bytes: Uint8Array, contentType: string | undefined): Promise<PreparedEdit> => {
  if (isJsonMediaType(contentType)) return prepareJsonEdit(bytes);
  if (isMultipartFormDataMediaType(contentType)) return await prepareMultipartEdit(bytes, contentType);
  return invalid('OpenAI Images Edits request body must use application/json or multipart/form-data.');
};
