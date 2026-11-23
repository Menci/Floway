import { base64ToBytes, bytesToBase64, parseBase64ImageDataUrl } from './image-helpers.ts';
import type { JsonRequestBody, MultipartField, MultipartFile, MultipartRequestBody } from './request-body.ts';
import { Bytes } from '@floway-dev/pipeline';
import type { OpenAIImageEditReference } from '@floway-dev/protocols/openai-images';

export type OpenAIImagesEditsSource =
  | ({ readonly type: 'upload' } & MultipartFile)
  | { readonly type: 'inline'; readonly reference: OpenAIImageEditReference & { readonly image_url: string } }
  | { readonly type: 'reference'; readonly reference: OpenAIImageEditReference };

export interface OpenAIImagesEditsRequest {
  readonly images: readonly OpenAIImagesEditsSource[];
  readonly mask?: OpenAIImagesEditsSource;
  readonly parameters: Readonly<Record<string, unknown>>;
}

const uploadedPart = (source: OpenAIImagesEditsSource, name: string, index: number): MultipartField | null => {
  if (source.type === 'upload') {
    const { bytes, contentType, filename } = source;
    return { kind: 'file', name, bytes, contentType, filename };
  }
  if (source.type === 'reference' || Object.keys(source.reference).some(key => key !== 'image_url')) return null;
  const parsed = parseBase64ImageDataUrl(source.reference.image_url);
  if (parsed === null) return null;
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(parsed.base64);
  } catch {
    // Keep an invalid inline upload in the JSON form the caller supplied.
    return null;
  }
  return { kind: 'file', name, bytes: Bytes.adopt(bytes), contentType: parsed.mimeType.toLowerCase(), filename: `image-${index}` };
};

const jsonReference = (source: OpenAIImagesEditsSource): OpenAIImageEditReference =>
  source.type === 'upload'
    ? { image_url: `data:${source.contentType};base64,${bytesToBase64(source.bytes.toUint8Array())}` }
    : source.reference;

export const serializeOpenAIImagesEditsJsonPayload = (
  request: OpenAIImagesEditsRequest,
  model: string,
): Record<string, unknown> => ({
  ...request.parameters,
  images: request.images.map(jsonReference),
  ...(request.mask === undefined ? {} : { mask: jsonReference(request.mask) }),
  model,
});

const multipartBody = (request: OpenAIImagesEditsRequest, model: string): MultipartRequestBody | null => {
  const parameters = Object.entries(request.parameters);
  if (parameters.some(([, value]) => typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean')) return null;
  const imageField = request.images.length === 1 ? 'image' : 'image[]';
  const files: MultipartField[] = [];
  for (const [index, source] of request.images.entries()) {
    const part = uploadedPart(source, imageField, index);
    if (part === null) return null;
    files.push(part);
  }
  if (request.mask !== undefined) {
    const mask = uploadedPart(request.mask, 'mask', files.length);
    if (mask === null) return null;
    files.push(mask);
  }
  return {
    kind: 'multipart',
    parts: [
      ...parameters.map(([name, value]): MultipartField => ({ kind: 'text', name, value: String(value) })),
      ...files,
      { kind: 'text', name: 'model', value: model },
    ],
  };
};

export const serializeOpenAIImagesEditsRequest = (
  request: OpenAIImagesEditsRequest,
  model: string,
): MultipartRequestBody | JsonRequestBody => multipartBody(request, model) ?? {
  kind: 'json',
  value: serializeOpenAIImagesEditsJsonPayload(request, model),
};
