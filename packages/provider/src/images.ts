import { base64ToBytes, bytesToBase64, parseBase64ImageDataUrl } from './image-helpers.ts';
import type { ImageEditReference } from '@floway-dev/protocols/images';

// Each source stores one authoritative representation. Multipart requires
// upload-like sources with no extra reference fields plus scalar parameters;
// every other request uses JSON and encodes File uploads as data URLs.
interface UploadedImagesEditsSource {
  type: 'upload';
  file: File;
}

interface InlineImagesEditsSource {
  type: 'inline';
  reference: ImageEditReference & { image_url: string };
}

interface ReferencedImagesEditsSource {
  type: 'reference';
  reference: ImageEditReference;
}

export type ImagesEditsSource = UploadedImagesEditsSource | InlineImagesEditsSource | ReferencedImagesEditsSource;

export interface ImagesEditsRequest {
  images: ImagesEditsSource[];
  mask?: ImagesEditsSource;
  parameters: Record<string, unknown>;
}

const uploadedFile = (source: ImagesEditsSource, index: number): File | null => {
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
  return new File([bytes], `image-${index}`, { type: parsed.mimeType });
};

const jsonReference = async (source: ImagesEditsSource): Promise<ImageEditReference> => {
  if (source.type === 'inline' || source.type === 'reference') return source.reference;
  const bytes = new Uint8Array(await source.file.arrayBuffer());
  return { image_url: `data:${source.file.type};base64,${bytesToBase64(bytes)}` };
};

const jsonBody = async (request: ImagesEditsRequest): Promise<Record<string, unknown>> => {
  const images = await Promise.all(request.images.map(jsonReference));
  const mask = request.mask === undefined ? undefined : await jsonReference(request.mask);
  return {
    ...request.parameters,
    images,
    ...(mask === undefined ? {} : { mask }),
  };
};

const multipartBody = (request: ImagesEditsRequest, model: string): FormData | null => {
  const sources = [...request.images, ...(request.mask === undefined ? [] : [request.mask])];
  const compatibleSources = sources.every(source =>
    source.type === 'upload'
    || (source.type === 'inline' && Object.keys(source.reference).every(key => key === 'image_url')));
  const compatibleParameters = Object.values(request.parameters).every(value =>
    typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean');
  if (!compatibleSources || !compatibleParameters) return null;

  const images: File[] = [];
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
  for (const image of images) form.append(imageField, image);
  if (mask !== undefined) form.append('mask', mask);
  form.append('model', model);
  return form;
};

export const serializeOpenAIImagesEditsRequest = async (request: ImagesEditsRequest, model: string): Promise<BodyInit> => {
  const multipart = multipartBody(request, model);
  if (multipart !== null) return multipart;
  return JSON.stringify({ ...await jsonBody(request), model });
};
