import { defineStage } from '../../pipeline/facts.ts';
import { jsonResponse, localHead, multipartFile, openAIError, readJsonModel, readMultipart } from '../shared/http.ts';
import { getHeader, type HttpRequestFact } from '@floway-dev/http';
import type { Result } from '@floway-dev/pipeline';
import { isJsonMediaType, isJsonObject, isMultipartFormDataMediaType } from '@floway-dev/protocols/common';
import type { OpenAIImagesEditsInput, OpenAIImagesEditsPayload } from '@floway-dev/protocols/openai-images';
import { isBase64ImageDataUrl } from '@floway-dev/upstream';

type PreparedEdit = Result<{ model: string; payload: OpenAIImagesEditsPayload }, string>;
const invalid = (error: string) => ({ ok: false as const, error });

const imageSource = (value: unknown, path: string): Result<OpenAIImagesEditsInput, string> => {
  if (!isJsonObject(value)) return invalid(`${path} must be an object.`);
  const { image_url: imageUrl, file_id: fileId, ...rest } = value;
  if (typeof imageUrl === 'string' && fileId === undefined) {
    const reference = { ...rest, image_url: imageUrl };
    return { ok: true, value: isBase64ImageDataUrl(imageUrl) ? { type: 'inline', reference } : { type: 'reference', reference } };
  }
  if (typeof fileId === 'string' && imageUrl === undefined) {
    return { ok: true, value: { type: 'reference', reference: { ...rest, file_id: fileId } } };
  }
  return invalid(`${path} must contain exactly one string field: image_url or file_id.`);
};

const prepareJsonEdit = (http: HttpRequestFact): PreparedEdit => {
  const parsed = readJsonModel(http, 'OpenAI Images Edits');
  if (!parsed.ok) return parsed;
  const { model, body } = parsed.value;
  const { model: _model, images: values, mask: maskValue, ...parameters } = body;
  if (!Array.isArray(values)) return invalid('OpenAI Images Edits request body must include an images array.');
  const images: OpenAIImagesEditsInput[] = [];
  for (const [index, value] of values.entries()) {
    const source = imageSource(value, `OpenAI Images Edits images[${index}]`);
    if (!source.ok) return source;
    images.push(source.value);
  }
  if (maskValue === undefined) return { ok: true, value: { model, payload: { images, parameters } } };
  const mask = imageSource(maskValue, 'OpenAI Images Edits mask');
  if (!mask.ok) return mask;
  return { ok: true, value: { model, payload: { images, mask: mask.value, parameters } } };
};

const prepareMultipartEdit = async (http: HttpRequestFact): Promise<PreparedEdit> => {
  const parsed = await readMultipart(http, 'OpenAI Images Edits');
  if (!parsed.ok) return parsed;
  const form = parsed.value;
  const model = form.get('model');
  if (typeof model !== 'string' || model.length === 0) {
    return invalid('OpenAI Images Edits request body must include a model field.');
  }
  const images: OpenAIImagesEditsInput[] = [];
  let mask: OpenAIImagesEditsInput | undefined;
  const fields: [string, string][] = [];
  for (const [name, value] of form) {
    if (name === 'model') continue;
    if (name === 'image' || name === 'image[]') {
      if (typeof value === 'string') return invalid(`OpenAI Images Edits ${name} fields must be files.`);
      images.push({ type: 'upload', file: await multipartFile(value) });
    } else if (name === 'mask') {
      if (typeof value === 'string') return invalid('OpenAI Images Edits mask field must be a file.');
      mask = { type: 'upload', file: await multipartFile(value) };
    } else {
      if (typeof value !== 'string') return invalid(`OpenAI Images Edits ${name} field must be text.`);
      fields.push([name, value]);
    }
  }
  const parameters = Object.fromEntries(fields);
  return { ok: true, value: { model, payload: { images, ...(mask === undefined ? {} : { mask }), parameters } } };
};

const prepareEdit = async (http: HttpRequestFact): Promise<PreparedEdit> => {
  const header = getHeader(http.headers, 'content-type');
  const contentType = typeof header === 'string' ? header : undefined;
  if (isJsonMediaType(contentType)) return prepareJsonEdit(http);
  if (isMultipartFormDataMediaType(contentType)) return await prepareMultipartEdit(http);
  return invalid('OpenAI Images Edits request body must use application/json or multipart/form-data.');
};

export const parseOpenAIImagesEdits = defineStage({
  name: 'openaiImagesEdits.parse',
  through: {
    request: { needs: ['http'], provides: ['openaiImagesEdits', 'requestedModel'], consumes: [] },
    response: { needs: ['http'], provides: [], consumes: [] },
  },
  return: { provides: ['http'] },
  async execute(facts, scope) {
    const parsed = await prepareEdit(facts.http);
    if (!parsed.ok) {
      scope.services.dump?.error('gateway');
      return { http: jsonResponse(localHead(400), openAIError(parsed.error)) };
    }
    const { model, payload } = parsed.value;
    scope.services.dump?.requestedModel(model);
    return await scope.next({ ...facts, requestedModel: model, openaiImagesEdits: payload });
  },
});
