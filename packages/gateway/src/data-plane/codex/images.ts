import type { Context } from 'hono';

import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import { createExternalImageFetcher, type ExternalImageFetchResult } from '../chat/shared/external-image-loader.ts';
import { createGatewayCtxFromHono, finalizeGatewayResponse } from '../chat/shared/gateway-ctx.ts';
import { readRequestBody, takeRequestBody } from '../chat/shared/request-body.ts';
import {
  prepareImageEditSources,
  supportedImageMimeFromBytes,
  type ImageEditSource,
  type PreparedImageEditSource,
} from '../images/edit-source.ts';
import { serveImagesEditForm } from '../images/serve.ts';
import { passthroughApiError } from '../shared/passthrough-serve.ts';

interface CodexImageEditRequest {
  images?: unknown;
  model?: unknown;
  prompt?: unknown;
  [key: string]: unknown;
}

type PreparedCodexEdit =
  | { type: 'ok'; form: FormData }
  | { type: 'invalid'; message: string };

type LoadedImage =
  | { type: 'ok'; source: ImageEditSource }
  | { type: 'invalid'; message: string };

const imageBytes = (data: Uint8Array): ArrayBuffer => data.byteOffset === 0
  && data.buffer instanceof ArrayBuffer
  && data.byteLength === data.buffer.byteLength
  ? data.buffer
  : Uint8Array.from(data).buffer;

const decodeDataUrl = (value: string, index: number): LoadedImage | null => {
  const match = /^data:image\/[a-z0-9.+-]+;base64,(.*)$/isu.exec(value);
  if (match === null) return null;

  let bytes: Uint8Array;
  try {
    const decoded = atob(match[1]!);
    bytes = Uint8Array.from(decoded, character => character.charCodeAt(0));
  } catch {
    return { type: 'invalid', message: `Codex image edits images[${index}].image_url must contain valid base64 image data.` };
  }
  const mimeType = supportedImageMimeFromBytes(bytes);
  return mimeType === null
    ? { type: 'invalid', message: `Codex image edits images[${index}].image_url must contain a supported raster image.` }
    : { type: 'ok', source: { bytes: imageBytes(bytes), mimeType } };
};

const externalImageError = (result: Exclude<ExternalImageFetchResult, { type: 'success' }>, index: number): string => {
  const path = `Codex image edits images[${index}].image_url`;
  switch (result.type) {
  case 'invalid-url': return `${path} must be an HTTP(S) URL or a base64 image data URL.`;
  case 'invalid-redirect': return `${path} has an invalid redirect (${result.reason}).`;
  case 'http-error': return `${path} returned HTTP ${result.status}.`;
  case 'too-large': return `${path} exceeds the ${result.limitBytes}-byte image limit.`;
  case 'empty-body': return `${path} returned an empty response.`;
  case 'timeout': return `${path} timed out.`;
  case 'transport-error': return `${path} could not be downloaded.`;
  }
};

const loadImage = async (
  value: unknown,
  index: number,
  fetchExternalImage: ReturnType<typeof createExternalImageFetcher>,
): Promise<LoadedImage> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { type: 'invalid', message: `Codex image edits images[${index}] must be an object.` };
  }
  const imageUrl = (value as { image_url?: unknown }).image_url;
  if (typeof imageUrl !== 'string') {
    return { type: 'invalid', message: `Codex image edits images[${index}].image_url must be a string.` };
  }

  const inline = decodeDataUrl(imageUrl, index);
  if (inline !== null) return inline;

  const result = await fetchExternalImage(imageUrl);
  if (result.type !== 'success') return { type: 'invalid', message: externalImageError(result, index) };
  const mimeType = supportedImageMimeFromBytes(result.data);
  return mimeType === null
    ? { type: 'invalid', message: `Codex image edits images[${index}].image_url must resolve to a supported raster image.` }
    : { type: 'ok', source: { bytes: imageBytes(result.data), mimeType } };
};

const imageFile = (source: PreparedImageEditSource, index: number): File => {
  const extension = source.mimeType === 'image/jpeg' ? 'jpg' : source.mimeType.slice('image/'.length);
  return new File([source.bytes], `image-${index + 1}.${extension}`, { type: source.mimeType });
};

const prepareCodexImageEdit = async (bytes: Uint8Array, signal: AbortSignal): Promise<PreparedCodexEdit> => {
  let request: CodexImageEditRequest;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { type: 'invalid', message: 'Codex image edits request body must be an object.' };
    }
    request = parsed as CodexImageEditRequest;
  } catch {
    return { type: 'invalid', message: 'Codex image edits request body must be valid JSON.' };
  }
  if (typeof request.model !== 'string' || request.model.length === 0) {
    return { type: 'invalid', message: 'Codex image edits request body must include a model string.' };
  }
  if (typeof request.prompt !== 'string') {
    return { type: 'invalid', message: 'Codex image edits request body must include a prompt string.' };
  }
  if (!Array.isArray(request.images) || request.images.length === 0) {
    return { type: 'invalid', message: 'Codex image edits request body must include at least one image.' };
  }

  const form = new FormData();
  for (const [name, value] of Object.entries(request)) {
    if (name === 'images') continue;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      return { type: 'invalid', message: `Codex image edits ${name} must be a string, number, or boolean.` };
    }
    form.append(name, String(value));
  }

  const fetchExternalImage = createExternalImageFetcher(signal);
  const sources: ImageEditSource[] = [];
  for (const [index, image] of request.images.entries()) {
    const loaded = await loadImage(image, index, fetchExternalImage);
    if (loaded.type === 'invalid') return loaded;
    sources.push(loaded.source);
  }
  const prepared = await prepareImageEditSources(sources);
  prepared.forEach((source, index) => form.append('image[]', imageFile(source, index)));
  return { type: 'ok', form };
};

// Codex's client-owned image extension posts JSON to provider-relative paths;
// the public OpenAI edits route remains multipart/form-data.
// https://github.com/openai/codex/blob/f90e7deea6a715bbd153044af6f475eefa749177/codex-rs/codex-api/src/endpoint/images.rs#L33-L68
// https://github.com/openai/codex/blob/f90e7deea6a715bbd153044af6f475eefa749177/codex-rs/codex-api/src/images.rs#L4-L31
export const codexImagesEdits = async (c: Context): Promise<Response> => {
  const requestBody = await readRequestBody(c);
  const prepared = await prepareCodexImageEdit(requestBody.bytes, c.req.raw.signal);
  if (prepared.type === 'invalid') {
    const ctx = createGatewayCtxFromHono(c, {
      wantsStream: false,
      requestBody: takeRequestBody(requestBody),
      backgroundScheduler: backgroundSchedulerFromContext(c),
    });
    ctx.dump?.error('gateway');
    return finalizeGatewayResponse(ctx, passthroughApiError(c, prepared.message, 400));
  }
  return await serveImagesEditForm(c, requestBody, prepared.form);
};
