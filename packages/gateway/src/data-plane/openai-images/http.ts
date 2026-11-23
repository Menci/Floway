import { createGatewayHttpHandler } from '../pipeline/host.ts';
import { createNonChatPipeline, header, parseJsonModel, type ParsedOperation, requestBytes, respondJsonUsage } from '../pipeline/non-chat.ts';
import { openaiImagesEditsProviderTargets, openaiImagesGenerationsProviderTargets } from '../providers/upstreams.ts';
import { tokenUsageFromOpenAIImagesBody } from '../shared/telemetry/usage.ts';
import type { HttpRequestFacts } from '@floway-dev/http';
import { Bytes } from '@floway-dev/pipeline';
import { isJsonMediaType, isMultipartFormDataMediaType } from '@floway-dev/protocols/common';
import type { OpenAIImageEditReference, OpenAIImagesGenerationsPayload } from '@floway-dev/protocols/openai-images';
import { isBase64ImageDataUrl, type OpenAIImagesEditsRequest, type OpenAIImagesEditsSource } from '@floway-dev/provider';

type PreparedOpenAIImagesEdit =
  | { type: 'ok'; request: OpenAIImagesEditsRequest }
  | { type: 'invalid'; message: string };

const openaiImageEditSource = (value: unknown, path: string): OpenAIImagesEditsSource | string => {
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

const prepareJsonOpenAIImagesEdit = (body: Record<string, unknown>): PreparedOpenAIImagesEdit => {
  if (!Array.isArray(body.images)) {
    return { type: 'invalid', message: 'OpenAI Images Edits request body must include an images array.' };
  }
  const images: OpenAIImagesEditsSource[] = [];
  for (const [index, value] of body.images.entries()) {
    const source = openaiImageEditSource(value, `OpenAI Images Edits images[${index}]`);
    if (typeof source === 'string') return { type: 'invalid', message: source };
    images.push(source);
  }
  let mask: OpenAIImagesEditsSource | undefined;
  if (body.mask !== undefined) {
    const source = openaiImageEditSource(body.mask, 'OpenAI Images Edits mask');
    if (typeof source === 'string') return { type: 'invalid', message: source };
    mask = source;
  }
  const { model: _model, images: _images, mask: _mask, ...parameters } = body;
  return {
    type: 'ok',
    request: {
      images,
      ...(mask === undefined ? {} : { mask }),
      parameters,
    },
  };
};

const parseImageEdits = async (http: HttpRequestFacts): Promise<ParsedOperation<OpenAIImagesEditsRequest>> => {
  const contentType = header(http.headers, 'content-type');
  if (isJsonMediaType(contentType)) {
    const body = parseJsonModel(http, 'OpenAI Images Edits');
    if ('error' in body) return body;
    const parsed = prepareJsonOpenAIImagesEdit(body.payload);
    return parsed.type === 'invalid' ? { error: parsed.message } : { model: body.model, payload: parsed.request };
  }

  if (!isMultipartFormDataMediaType(contentType)) {
    return { error: 'OpenAI Images Edits request body must use application/json or multipart/form-data.' };
  }
  const bytes = requestBytes(http);
  let form: FormData;
  try {
    form = await new Response(bytes.toUint8Array() as Uint8Array<ArrayBuffer>, { headers: { 'content-type': contentType } }).formData();
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return { error: 'OpenAI Images Edits request body must be valid multipart/form-data.' };
  }
  const model = form.get('model');
  if (typeof model !== 'string' || model.length === 0) {
    return { error: 'OpenAI Images Edits request body must include a model field.' };
  }
  const uploaded = async (file: File): Promise<OpenAIImagesEditsSource> => ({
    type: 'upload',
    bytes: Bytes.adopt(new Uint8Array(await file.arrayBuffer())),
    filename: file.name,
    contentType: file.type,
  });
  const images: OpenAIImagesEditsSource[] = [];
  let mask: OpenAIImagesEditsSource | undefined;
  const parameters: Record<string, string> = {};
  for (const [name, value] of form.entries()) {
    if (name === 'model') continue;
    if (name === 'image' || name === 'image[]') {
      if (!(value instanceof File)) return { error: `OpenAI Images Edits ${name} fields must be files.` };
      images.push(await uploaded(value));
    } else if (name === 'mask') {
      if (!(value instanceof File)) return { error: 'OpenAI Images Edits mask field must be a file.' };
      mask = await uploaded(value);
    } else {
      if (typeof value !== 'string') return { error: `OpenAI Images Edits ${name} field must be text.` };
      parameters[name] = value;
    }
  }
  return { model, payload: { images, ...(mask === undefined ? {} : { mask }), parameters } };
};

type GenerationsPayload = Omit<OpenAIImagesGenerationsPayload, 'model'>;
export const openaiImagesGenerationsIngress = createNonChatPipeline({
  name: 'openai-images-generations',
  sourceApi: '/images/generations',
  kind: 'image',
  operation: 'image_generation',
  parse: http => {
    const parsed = parseJsonModel(http, 'OpenAI Images Generations');
    return 'error' in parsed ? parsed : { model: parsed.model, payload: parsed.payload as GenerationsPayload };
  },
  outcomeKey: 'response.openaiImagesGenerations',
  targets: openaiImagesGenerationsProviderTargets,
  select: candidates => candidates.filter(candidate => candidate.endpoints.openaiImagesGenerations !== undefined),
  respond: (response, _request, identity, scope) => respondJsonUsage(response['response.http'], identity, scope, '/images/generations', tokenUsageFromOpenAIImagesBody),
});

const imagesEditsIngress = createNonChatPipeline({
  name: 'openai-images-edits',
  sourceApi: '/images/edits',
  kind: 'image',
  operation: 'image_edit',
  parse: parseImageEdits,
  outcomeKey: 'response.openaiImagesEdits',
  targets: openaiImagesEditsProviderTargets,
  select: candidates => candidates.filter(candidate => candidate.endpoints.openaiImagesEdits !== undefined),
  respond: (response, _request, identity, scope) => respondJsonUsage(response['response.http'], identity, scope, '/images/edits', tokenUsageFromOpenAIImagesBody),
});

export const openaiImagesGenerations = createGatewayHttpHandler(openaiImagesGenerationsIngress, { errorStatus: () => 502 });
export const openaiImagesEdits = createGatewayHttpHandler(imagesEditsIngress, { errorStatus: () => 502 });
