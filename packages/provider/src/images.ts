import { base64ToBytes, bytesToBase64, parseBase64ImageDataUrl } from './image-helpers.ts';
import { jsonRequestBody } from './json-request.ts';
import { multipartFile, serializeMultipartHttpBody, type UploadedFile } from './multipart.ts';
import type { ReplayableBody } from './options.ts';
import type { OpenAIImageEditReference } from '@floway-dev/protocols/openai-images';

// Each source stores one authoritative representation. Multipart requires
// upload-like sources with no extra reference fields plus scalar parameters;
// every other request uses JSON and encodes the uploaded bytes as data URLs.
interface UploadedOpenAIImagesEditsSource {
  type: 'upload';
  readonly file: UploadedFile;
}

interface InlineOpenAIImagesEditsSource {
  type: 'inline';
  reference: OpenAIImageEditReference & { image_url: string };
}

interface ReferencedOpenAIImagesEditsSource {
  type: 'reference';
  reference: OpenAIImageEditReference;
}

export type OpenAIImagesEditsSource = UploadedOpenAIImagesEditsSource | InlineOpenAIImagesEditsSource | ReferencedOpenAIImagesEditsSource;

export interface OpenAIImagesEditsRequest {
  images: OpenAIImagesEditsSource[];
  mask?: OpenAIImagesEditsSource;
  parameters: Record<string, unknown>;
}

const uploadedFile = (source: OpenAIImagesEditsSource, index: number): UploadedFile | null => {
  if (source.type === 'upload') return source.file;
  if (source.type === 'reference') return null;
  const parsed = parseBase64ImageDataUrl(source.reference.image_url);
  if (parsed === null) return null;
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = base64ToBytes(parsed.base64);
  } catch {
    return null;
  }
  return { name: `image-${index}`, type: parsed.mimeType, bytes };
};

const jsonReference = (source: OpenAIImagesEditsSource): OpenAIImageEditReference => {
  if (source.type === 'inline' || source.type === 'reference') return source.reference;
  return { image_url: `data:${source.file.type};base64,${bytesToBase64(source.file.bytes)}` };
};

export const serializeOpenAIImagesEditsJsonPayload = (
  request: OpenAIImagesEditsRequest,
  model: string,
): Record<string, unknown> => ({
  ...request.parameters,
  images: request.images.map(jsonReference),
  ...(request.mask === undefined ? {} : { mask: jsonReference(request.mask) }),
  model,
});

const multipartBody = (request: OpenAIImagesEditsRequest, model: string): FormData | null => {
  const sources = [...request.images, ...(request.mask === undefined ? [] : [request.mask])];
  const compatibleSources = sources.every(source =>
    source.type === 'upload'
    || (source.type === 'inline' && Object.keys(source.reference).every(key => key === 'image_url')));
  const compatibleParameters = Object.values(request.parameters).every(value =>
    typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean');
  if (!compatibleSources || !compatibleParameters) return null;

  const images: UploadedFile[] = [];
  for (const [index, source] of request.images.entries()) {
    const file = uploadedFile(source, index);
    if (file === null) return null;
    images.push(file);
  }
  const mask = request.mask === undefined ? undefined : uploadedFile(request.mask, images.length);
  if (mask === null) return null;

  const form = new FormData();
  for (const [name, value] of Object.entries(request.parameters)) form.append(name, String(value));
  const imageField = images.length === 1 ? 'image' : 'image[]';
  for (const image of images) form.append(imageField, multipartFile(image));
  if (mask !== undefined) form.append('mask', multipartFile(mask));
  form.append('model', model);
  return form;
};

export const serializeOpenAIImagesEditsRequest = (request: OpenAIImagesEditsRequest, model: string): FormData | ReplayableBody => {
  const multipart = multipartBody(request, model);
  if (multipart !== null) return multipart;
  return jsonRequestBody(serializeOpenAIImagesEditsJsonPayload(request, model));
};

export const serializeOpenAIImagesEditsHttpBody = async (
  request: OpenAIImagesEditsRequest,
  model: string,
): Promise<{ readonly body: Uint8Array<ArrayBuffer>; readonly contentType: string }> => {
  const serialized = serializeOpenAIImagesEditsRequest(request, model);
  if (serialized instanceof FormData) return await serializeMultipartHttpBody(serialized);
  return { body: new Uint8Array(await new Response(serialized.open()).arrayBuffer()), contentType: 'application/json' };
};
