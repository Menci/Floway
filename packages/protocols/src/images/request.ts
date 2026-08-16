// Reading what the client sent into the canonical request. The two endpoints take different
// bodies — generations is JSON, edits is JSON or a multipart form — and each message here is
// what the client is told, so they name the endpoint and the field they are about.

import type { CanonicalImagesRequest, ImageEditReference, ImagesEditImage, ImagesUploadedFile, ParsedImagesRequest } from './index.ts';
import { isJsonMediaType, isMultipartFormDataMediaType } from '../common/media-type.ts';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Whether the client asked for the answer as a stream.
 *
 * The flag rides on to the upstream inside `parameters` exactly as it arrived, and this is the
 * gateway's own reading of it. It is two values rather than one because an edit may be sent as
 * a multipart form, where every field arrives as the text the client typed, while generations
 * and a JSON edit carry the boolean the specification names.
 * https://github.com/openai/openai-openapi/blob/a3276900e58b8b2a92e0cb087cd2e6e005f58458/openapi.yaml#L47542-L47673
 */
export const imagesRequestWantsStream = (request: CanonicalImagesRequest): boolean =>
  request.parameters.stream === true || request.parameters.stream === 'true';

const jsonObject = (body: Uint8Array, endpoint: string): Record<string, unknown> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    throw new Error(`${endpoint} request body must be valid JSON.`);
  }
  if (!isRecord(parsed)) throw new Error(`${endpoint} request body must be an object.`);
  return parsed;
};

/** Routing owns the model id, so it comes out of the payload rather than travelling inside it.
 *  Every other field is the upstream's business and is passed on untouched. */
const requiredModel = (body: Record<string, unknown>, endpoint: string): string => {
  const { model } = body;
  if (typeof model !== 'string' || model.length === 0) {
    throw new Error(`${endpoint} request body must include a model string.`);
  }
  return model;
};

export const parseImagesGenerationsRequest = (body: Uint8Array): ParsedImagesRequest => {
  const payload = jsonObject(body, 'Images generations');
  const model = requiredModel(payload, 'Images generations');
  const { model: _model, ...parameters } = payload;
  return { model, request: { operation: 'generations', parameters } };
};

export const parseImagesEditsRequest = async (
  contentType: string | null | undefined,
  body: Uint8Array,
): Promise<ParsedImagesRequest> => {
  if (isJsonMediaType(contentType)) return jsonEdits(body);
  if (isMultipartFormDataMediaType(contentType)) return await multipartEdits(contentType, body);
  throw new Error('Image edits request body must use application/json or multipart/form-data.');
};

const jsonEdits = (body: Uint8Array): ParsedImagesRequest => {
  const payload = jsonObject(body, 'Image edits');
  const model = requiredModel(payload, 'Image edits');
  if (!Array.isArray(payload.images)) {
    throw new Error('Image edits request body must include an images array.');
  }
  const images = payload.images.map((value, index) => referenceImage(value, `Image edits images[${index}]`));
  const mask = payload.mask === undefined ? undefined : referenceImage(payload.mask, 'Image edits mask');
  const { model: _model, images: _images, mask: _mask, ...parameters } = payload;
  return {
    model,
    request: { operation: 'edits', images, ...(mask === undefined ? {} : { mask }), parameters },
  };
};

const referenceImage = (value: unknown, path: string): ImagesEditImage => {
  if (!isRecord(value)) throw new Error(`${path} must be an object.`);
  const { image_url: imageUrl, file_id: fileId } = value;
  const named = (typeof imageUrl === 'string' && fileId === undefined)
    || (typeof fileId === 'string' && imageUrl === undefined);
  if (!named) throw new Error(`${path} must contain exactly one string field: image_url or file_id.`);
  return { kind: 'reference', reference: value as ImageEditReference };
};

const multipartEdits = async (contentType: string, body: Uint8Array): Promise<ParsedImagesRequest> => {
  let form: FormData;
  try {
    // `BodyInit` excludes a view over a `SharedArrayBuffer`, which an inbound body never is.
    form = await new Response(body as BodyInit, { headers: { 'content-type': contentType } }).formData();
  } catch {
    throw new Error('Image edits request body must be valid multipart/form-data.');
  }

  const model = form.get('model');
  if (typeof model !== 'string' || model.length === 0) {
    throw new Error('Image edits request body must include a model field.');
  }

  const images: ImagesEditImage[] = [];
  let mask: ImagesEditImage | undefined;
  const parameters: Record<string, unknown> = {};
  for (const [name, value] of form.entries()) {
    if (name === 'model') continue;
    // One image is sent as `image` and several as `image[]`; the upstream serializer picks the
    // field name back off the count, so the two arrive at one list here.
    if (name === 'image' || name === 'image[]') {
      images.push({ kind: 'file', file: await uploadedFile(value, `Image edits ${name} fields must be files.`) });
    } else if (name === 'mask') {
      mask = { kind: 'file', file: await uploadedFile(value, 'Image edits mask field must be a file.') };
    } else {
      if (typeof value !== 'string') throw new Error(`Image edits ${name} field must be text.`);
      parameters[name] = value;
    }
  }

  return {
    model,
    request: { operation: 'edits', images, ...(mask === undefined ? {} : { mask }), parameters },
  };
};

const uploadedFile = async (value: FormDataEntryValue, message: string): Promise<ImagesUploadedFile> => {
  if (!(value instanceof File)) throw new Error(message);
  return { fileName: value.name, mediaType: value.type, bytes: new Uint8Array(await value.arrayBuffer()) };
};
