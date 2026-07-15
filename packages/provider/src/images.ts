import type { ImageEditReference } from '@floway-dev/protocols/images';

// The gateway normalizes both public wire formats into one homogeneous source
// kind. Providers serialize references as JSON and uploads as multipart
// without downloading URLs or base64-encoding uploaded bytes.
interface ImagesEditsRequestBase {
  parameters: Record<string, unknown>;
}

export interface UploadedImagesEditsRequest extends ImagesEditsRequestBase {
  type: 'uploads';
  images: File[];
  mask?: File;
}

export interface ReferencedImagesEditsRequest extends ImagesEditsRequestBase {
  type: 'references';
  images: ImageEditReference[];
  mask?: ImageEditReference;
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
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new Error(`Multipart image edits parameter ${name} must be a string, number, or boolean`);
    }
    form.append(name, String(value));
  }
  for (const image of request.images) form.append('image[]', image);
  if (request.mask !== undefined) form.append('mask', request.mask);
  form.append('model', model);
  return form;
};
