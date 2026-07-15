import type { ImageEditReference } from '@floway-dev/protocols/images';

// Inline data URLs are decoded into uploads before reaching this boundary.
// Providers prefer multipart when every source is an upload and use JSON for
// external references or mixed requests.
interface UploadedImagesEditsSource {
  type: 'upload';
  file: File;
}

interface ReferencedImagesEditsSource {
  type: 'reference';
  reference: ImageEditReference;
}

export type ImagesEditsSource = UploadedImagesEditsSource | ReferencedImagesEditsSource;

export interface ImagesEditsRequest {
  images: ImagesEditsSource[];
  mask?: ImagesEditsSource;
  parameters: Record<string, unknown>;
}

interface MultipartImagesEditsRequest extends ImagesEditsRequest {
  images: UploadedImagesEditsSource[];
  mask?: UploadedImagesEditsSource;
  parameters: Record<string, string | number | boolean>;
}

export const imagesEditsCanUseMultipart = (request: ImagesEditsRequest): request is MultipartImagesEditsRequest => {
  const sources = [...request.images, ...(request.mask === undefined ? [] : [request.mask])];
  return sources.every(source => source.type === 'upload')
    && Object.values(request.parameters).every(value =>
      typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean');
};

const bytesToBase64 = (bytes: Uint8Array): string => {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32_768)));
  }
  return btoa(chunks.join(''));
};

const jsonReference = async (source: ImagesEditsSource): Promise<ImageEditReference> => {
  if (source.type === 'reference') return source.reference;
  const bytes = new Uint8Array(await source.file.arrayBuffer());
  return { image_url: `data:${source.file.type};base64,${bytesToBase64(bytes)}` };
};

export const imagesEditsJsonBody = async (request: ImagesEditsRequest): Promise<Record<string, unknown>> => {
  const images = await Promise.all(request.images.map(jsonReference));
  const mask = request.mask === undefined ? undefined : await jsonReference(request.mask);
  return {
    ...request.parameters,
    images,
    ...(mask === undefined ? {} : { mask }),
  };
};

export const imagesEditsMultipartBody = (request: MultipartImagesEditsRequest, model: string): FormData => {
  const form = new FormData();
  for (const [name, value] of Object.entries(request.parameters)) {
    form.append(name, String(value));
  }
  const uploads = request.images.map(source => source.file);
  const imageField = uploads.length === 1 ? 'image' : 'image[]';
  for (const image of uploads) form.append(imageField, image);
  if (request.mask !== undefined) form.append('mask', request.mask.file);
  form.append('model', model);
  return form;
};
