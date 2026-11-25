import { gatewayFactSpace } from '../../../pipeline/facts.ts';
import { jsonResponseBody, responseHead } from '../../../pipeline/response.ts';
import { prepareJsonModelRequest } from '../../../shared/json-model-request.ts';
import { getHeader, readHttpBody } from '@floway-dev/http';
import { move } from '@floway-dev/pipeline';
import { isJsonMediaType, isMultipartFormDataMediaType } from '@floway-dev/protocols/common';
import { formatOpenAIImagesEditsError, openAIImagesStreamRequested, type OpenAIImageEditReference } from '@floway-dev/protocols/openai-images';
import { isBase64ImageDataUrl, readUploadedFile, type OpenAIImagesEditsRequest, type OpenAIImagesEditsSource, type UploadedFile } from '@floway-dev/provider';

const { defineStage } = gatewayFactSpace<{}>();

type PreparedOpenAIImagesEdits =
  | { type: 'ok'; model: string; request: OpenAIImagesEditsRequest }
  | { type: 'invalid'; message: string };

const invalid = (message: string): PreparedOpenAIImagesEdits => ({ type: 'invalid', message });

const openAIImageEditSource = (value: unknown, path: string): OpenAIImagesEditsSource | string => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return `${path} must be an object.`;
  }
  const reference = value as { image_url?: unknown; file_id?: unknown };
  const { image_url: imageUrl, file_id: fileId } = reference;
  if (typeof imageUrl === 'string' && fileId === undefined) {
    const imageReference = reference as OpenAIImageEditReference & { image_url: string };
    return isBase64ImageDataUrl(imageUrl)
      ? { type: 'inline', reference: imageReference }
      : { type: 'reference', reference: imageReference };
  }
  if (typeof fileId === 'string' && imageUrl === undefined) {
    return { type: 'reference', reference: reference as OpenAIImageEditReference };
  }
  return `${path} must contain exactly one string field: image_url or file_id.`;
};

const parseJson = (bytes: Uint8Array): PreparedOpenAIImagesEdits => {
  const parsed = prepareJsonModelRequest(bytes, 'OpenAI Images Edits');
  if (parsed.type === 'invalid') return parsed;
  const { images: references, mask: maskReference, model: _model, ...parameters } = parsed.body;
  if (!Array.isArray(references)) return invalid('OpenAI Images Edits request body must include an images array.');

  const images: OpenAIImagesEditsSource[] = [];
  for (const [index, reference] of references.entries()) {
    const source = openAIImageEditSource(reference, `OpenAI Images Edits images[${index}]`);
    if (typeof source === 'string') return invalid(source);
    images.push(source);
  }
  const mask = maskReference === undefined ? undefined : openAIImageEditSource(maskReference, 'OpenAI Images Edits mask');
  if (typeof mask === 'string') return invalid(mask);
  return {
    type: 'ok',
    model: parsed.model,
    request: { images, ...(mask === undefined ? {} : { mask }), parameters },
  };
};

const parseMultipart = async (bytes: Uint8Array, contentType: string): Promise<PreparedOpenAIImagesEdits> => {
  let form: FormData;
  try {
    form = await new Response(bytes as BodyInit, { headers: { 'content-type': contentType } }).formData();
  } catch {
    return invalid('OpenAI Images Edits request body must be valid multipart/form-data.');
  }
  const model = form.get('model');
  if (typeof model !== 'string' || model.length === 0) {
    return invalid('OpenAI Images Edits request body must include a model field.');
  }
  const images: OpenAIImagesEditsSource[] = [];
  let mask: UploadedFile | undefined;
  const parameters: Record<string, string> = {};
  for (const [name, value] of form.entries()) {
    if (name === 'model') continue;
    if (name === 'image' || name === 'image[]') {
      if (!(value instanceof File)) return invalid(`OpenAI Images Edits ${name} fields must be files.`);
      images.push({ type: 'upload', file: await readUploadedFile(value) });
    } else if (name === 'mask') {
      if (!(value instanceof File)) return invalid('OpenAI Images Edits mask field must be a file.');
      mask = await readUploadedFile(value);
    } else {
      if (typeof value !== 'string') return invalid(`OpenAI Images Edits ${name} field must be text.`);
      parameters[name] = value;
    }
  }
  return {
    type: 'ok',
    model,
    request: { images, ...(mask === undefined ? {} : { mask: { type: 'upload', file: mask } }), parameters },
  };
};

export const openAIImagesEditsError = (status: number, message: string) => ({
  'response.http': move(responseHead(status)),
  'response.openaiImagesEdits': move({ kind: 'error', source: 'local', error: formatOpenAIImagesEditsError(status, message) } as const),
});

export const parseOpenAIImagesEdits = defineStage({
  name: 'openaiImagesEdits.parse-request',
  through: {
    request: { needs: ['request.http'], provides: ['request.openaiImagesEdits', 'serve.model', 'request.delivery'], consumes: [] },
    response: { needs: ['response.http'], provides: [], consumes: [] },
  },
  return: { provides: ['response.http'] },
  async execute(facts, scope) {
    const request = facts['request.http'];
    const raw = await readHttpBody(request.body);
    const contentType = getHeader(request.headers, 'content-type');
    let parsed: PreparedOpenAIImagesEdits;
    if (typeof contentType === 'string' && isJsonMediaType(contentType)) {
      parsed = raw.ok ? parseJson(raw.value) : invalid('OpenAI Images Edits request body must be valid JSON.');
    } else if (typeof contentType === 'string' && isMultipartFormDataMediaType(contentType)) {
      parsed = raw.ok ? await parseMultipart(raw.value, contentType) : invalid('OpenAI Images Edits request body must be valid multipart/form-data.');
    } else {
      parsed = invalid('OpenAI Images Edits request body must use application/json or multipart/form-data.');
    }
    if (parsed.type === 'invalid') return {
      'response.http': move(jsonResponseBody(responseHead(400), formatOpenAIImagesEditsError(400, parsed.message))),
    };

    return await scope.next({
      ...facts,
      'request.openaiImagesEdits': move(parsed.request),
      'request.delivery': move(openAIImagesStreamRequested(parsed.request.parameters.stream) ? { kind: 'sse', includeUsage: true } as const : { kind: 'json' } as const),
      'serve.model': parsed.model,
    });
  },
});
