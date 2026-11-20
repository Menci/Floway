import { base64ToBytes, bytesToBase64, parseBase64ImageDataUrl } from './image-helpers.ts';
import { multipartBody as httpMultipartBody, type HttpFile, type HttpFormEntry, type HttpBody, type HttpBodyEncoding } from '@floway-dev/http/request-content';
import type { OpenAIImageEditReference } from '@floway-dev/protocols/openai-images';

// Each source stores one authoritative representation. Multipart requires
// upload-like sources with no extra reference fields plus scalar parameters;
// every other request uses JSON and encodes upload bytes as data URLs.
interface UploadedOpenAIImagesEditsSource {
  type: 'upload';
  file: HttpFile;
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

const uploadedFile = (source: OpenAIImagesEditsSource, index: number): HttpFile | null => {
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
  return { bytes, name: `image-${index}`, type: parsed.mimeType };
};

const jsonReference = async (source: OpenAIImagesEditsSource): Promise<OpenAIImageEditReference> => {
  if (source.type === 'inline' || source.type === 'reference') return source.reference;
  return { image_url: `data:${source.file.type};base64,${bytesToBase64(source.file.bytes)}` };
};

const jsonBody = async (request: OpenAIImagesEditsRequest): Promise<Record<string, unknown>> => {
  const images = await Promise.all(request.images.map(jsonReference));
  const mask = request.mask === undefined ? undefined : await jsonReference(request.mask);
  return {
    ...request.parameters,
    images,
    ...(mask === undefined ? {} : { mask }),
  };
};

export const serializeOpenAIImagesEditsJsonPayload = async (
  request: OpenAIImagesEditsRequest,
  model: string,
): Promise<Record<string, unknown>> => ({ ...await jsonBody(request), model });

const multipartEntries = (request: OpenAIImagesEditsRequest, model: string): readonly HttpFormEntry[] | null => {
  const sources = [...request.images, ...(request.mask === undefined ? [] : [request.mask])];
  const compatibleSources = sources.every(source =>
    source.type === 'upload'
    || (source.type === 'inline' && Object.keys(source.reference).every(key => key === 'image_url')));
  const compatibleParameters = Object.values(request.parameters).every(value =>
    typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean');
  if (!compatibleSources || !compatibleParameters) return null;

  const images: HttpFile[] = [];
  for (const [index, source] of request.images.entries()) {
    const file = uploadedFile(source, index);
    if (file === null) return null;
    images.push(file);
  }
  const mask = request.mask === undefined ? undefined : uploadedFile(request.mask, images.length);
  if (mask === null) return null;

  const entries: HttpFormEntry[] = Object.entries(request.parameters).map(([name, value]) => ({ name, value: String(value) }));
  const imageField = images.length === 1 ? 'image' : 'image[]';
  for (const image of images) entries.push({ name: imageField, value: image });
  if (mask !== undefined) entries.push({ name: 'mask', value: mask });
  entries.push({ name: 'model', value: model });
  return entries;
};

export const prepareOpenAIImagesEditsBody = async (request: OpenAIImagesEditsRequest, model: string): Promise<{ body: HttpBody; encoding: HttpBodyEncoding }> => {
  const entries = multipartEntries(request, model);
  return entries === null
    ? { body: await serializeOpenAIImagesEditsJsonPayload(request, model), encoding: 'json' }
    : { body: httpMultipartBody(entries), encoding: 'multipart' };
};
