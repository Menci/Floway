import type { ImageEditReference } from '@floway-dev/protocols/images';

// The gateway normalizes each public wire format into one of two semantic
// source kinds. Providers serialize references as JSON and uploads as
// multipart without downloading URLs or base64-encoding uploaded bytes.
export interface UploadedImagesEditsRequest {
  type: 'uploads';
  images: File[];
  mask?: File;
  parameters: Record<string, string | number | boolean>;
}

export interface ReferencedImagesEditsRequest {
  type: 'references';
  images: ImageEditReference[];
  mask?: ImageEditReference;
  parameters: Record<string, unknown>;
}

export type ImagesEditsRequest = UploadedImagesEditsRequest | ReferencedImagesEditsRequest;

export const imagesEditsJsonBody = (request: ReferencedImagesEditsRequest): Record<string, unknown> => ({
  ...request.parameters,
  images: request.images,
  ...(request.mask === undefined ? {} : { mask: request.mask }),
});

export const imagesEditsMultipartBody = (request: UploadedImagesEditsRequest, model: string): FormData => {
  const form = new FormData();
  for (const [name, value] of Object.entries(request.parameters)) {
    form.append(name, String(value));
  }
  const imageField = request.images.length === 1 ? 'image' : 'image[]';
  for (const image of request.images) form.append(imageField, image);
  if (request.mask !== undefined) form.append('mask', request.mask);
  form.append('model', model);
  return form;
};
