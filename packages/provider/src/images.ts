import { base64ToBytes, bytesToBase64, parseBase64ImageDataUrl } from './image-helpers.ts';
import { createReplayableBody } from './replayable-body.ts';
import type { ImageEditReference } from '@floway-dev/protocols/images';

interface UploadedImagesEditsSource {
  type: 'upload';
  file: File;
}

export interface RawImagesEditsUpload {
  readonly name: string;
  readonly type: string;
  readonly bytes: Uint8Array;
}

interface RawUploadedImagesEditsSource {
  type: 'raw-upload';
  upload: RawImagesEditsUpload;
}

interface InlineImagesEditsSource {
  type: 'inline';
  reference: ImageEditReference & { image_url: string };
}

interface ReferencedImagesEditsSource {
  type: 'reference';
  reference: ImageEditReference;
}

export type ImagesEditsSource =
  | UploadedImagesEditsSource
  | RawUploadedImagesEditsSource
  | InlineImagesEditsSource
  | ReferencedImagesEditsSource;

export interface ImagesEditsRequest {
  images: ImagesEditsSource[];
  mask?: ImagesEditsSource;
  parameters: Record<string, unknown>;
}

export interface SerializedImagesEditsRequest {
  readonly body: BodyInit;
  readonly contentType: string;
}

interface UploadBytes {
  readonly name: string;
  readonly type: string;
  readonly bytes: Uint8Array;
}

const uploadBytes = async (source: ImagesEditsSource, index: number): Promise<UploadBytes | null> => {
  if (source.type === 'raw-upload') return source.upload;
  if (source.type === 'upload') {
    return {
      name: source.file.name,
      type: source.file.type,
      bytes: new Uint8Array(await source.file.arrayBuffer()),
    };
  }
  if (source.type === 'reference') return null;
  const parsed = parseBase64ImageDataUrl(source.reference.image_url);
  if (parsed === null) return null;
  try {
    return { name: `image-${index}`, type: parsed.mimeType, bytes: base64ToBytes(parsed.base64) };
  } catch {
    return null;
  }
};

const jsonReference = async (source: ImagesEditsSource): Promise<ImageEditReference> => {
  if (source.type === 'inline' || source.type === 'reference') return source.reference;
  const upload = source.type === 'raw-upload'
    ? source.upload
    : {
        type: source.file.type,
        bytes: new Uint8Array(await source.file.arrayBuffer()),
      };
  return { image_url: `data:${upload.type};base64,${bytesToBase64(upload.bytes)}` };
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

const encoder = new TextEncoder();

const escapeHeaderValue = (value: string): string => value
  .replace(/\r/gu, '%0D')
  .replace(/\n/gu, '%0A')
  .replace(/"/gu, '%22');

const multipartHeader = (boundary: string, name: string, filename?: string, type?: string): Uint8Array => {
  const disposition = `--${boundary}\r\nContent-Disposition: form-data; name="${escapeHeaderValue(name)}"`;
  if (filename === undefined) return encoder.encode(`${disposition}\r\n\r\n`);
  const contentType = type === undefined || type === '' ? 'application/octet-stream' : type;
  return encoder.encode(`${disposition}; filename="${escapeHeaderValue(filename)}"\r\nContent-Type: ${contentType}\r\n\r\n`);
};

const multipartBody = async (request: ImagesEditsRequest, model: string): Promise<SerializedImagesEditsRequest | null> => {
  const sources = [...request.images, ...(request.mask === undefined ? [] : [request.mask])];
  const compatibleSources = sources.every(source =>
    source.type === 'upload'
    || source.type === 'raw-upload'
    || (source.type === 'inline' && Object.keys(source.reference).every(key => key === 'image_url')));
  const compatibleParameters = Object.values(request.parameters).every(value =>
    typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean');
  if (!compatibleSources || !compatibleParameters) return null;

  const images = await Promise.all(request.images.map(uploadBytes));
  if (images.some(image => image === null)) return null;
  const mask = request.mask === undefined ? undefined : await uploadBytes(request.mask, images.length);
  if (mask === null) return null;

  const boundary = `floway-${crypto.randomUUID()}`;
  const segments: Uint8Array[] = [];
  const appendText = (name: string, value: string): void => {
    segments.push(multipartHeader(boundary, name), encoder.encode(value), encoder.encode('\r\n'));
  };
  const appendUpload = (name: string, upload: UploadBytes): void => {
    segments.push(
      multipartHeader(boundary, name, upload.name, upload.type),
      upload.bytes,
      encoder.encode('\r\n'),
    );
  };

  for (const [name, value] of Object.entries(request.parameters)) appendText(name, String(value));
  const imageField = images.length === 1 ? 'image' : 'image[]';
  for (const image of images as UploadBytes[]) appendUpload(imageField, image);
  if (mask !== undefined) appendUpload('mask', mask);
  appendText('model', model);
  segments.push(encoder.encode(`--${boundary}--\r\n`));
  return {
    body: createReplayableBody(segments),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
};

export const serializeOpenAIImagesEditsRequest = async (
  request: ImagesEditsRequest,
  model: string,
): Promise<SerializedImagesEditsRequest> => {
  const multipart = await multipartBody(request, model);
  if (multipart !== null) return multipart;
  return {
    body: JSON.stringify({ ...await jsonBody(request), model }),
    contentType: 'application/json',
  };
};
