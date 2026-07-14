import type { Context } from 'hono';

import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import { createGatewayCtxFromHono, finalizeGatewayResponse } from '../chat/shared/gateway-ctx.ts';
import { readRequestBody, takeRequestBody, type RequestBody } from '../chat/shared/request-body.ts';
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

const invalidRequest = (c: Context, requestBody: RequestBody, message: string): Response => {
  const ctx = createGatewayCtxFromHono(c, {
    wantsStream: false,
    requestBody: takeRequestBody(requestBody),
    backgroundScheduler: backgroundSchedulerFromContext(c),
  });
  ctx.dump?.error('gateway');
  return finalizeGatewayResponse(ctx, passthroughApiError(c, message, 400));
};

const imageFile = (value: unknown, index: number): File | string => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return `Codex image edits images[${index}] must be an object.`;
  }
  const imageUrl = (value as { image_url?: unknown }).image_url;
  if (typeof imageUrl !== 'string') {
    return `Codex image edits images[${index}].image_url must be a string.`;
  }
  const match = /^data:(image\/[a-z0-9.+-]+);base64,(.*)$/isu.exec(imageUrl);
  if (!match) {
    return `Codex image edits images[${index}].image_url must be a base64 image data URL.`;
  }
  let data: ArrayBuffer;
  try {
    const decoded = atob(match[2]!);
    data = new ArrayBuffer(decoded.length);
    const bytes = new Uint8Array(data);
    for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
  } catch {
    return `Codex image edits images[${index}].image_url must contain valid base64 image data.`;
  }
  const mimeType = match[1]!.toLowerCase();
  const extension = mimeType === 'image/jpeg' ? 'jpg' : mimeType.slice('image/'.length).replace(/[^a-z0-9]+/gu, '-');
  return new File([data], `image-${index + 1}.${extension}`, { type: mimeType });
};

const prepareCodexImageEdit = (bytes: Uint8Array): PreparedCodexEdit => {
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
  if (typeof request.prompt !== 'string' || request.prompt.length === 0) {
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
  for (const [index, image] of request.images.entries()) {
    const file = imageFile(image, index);
    if (typeof file === 'string') return { type: 'invalid', message: file };
    form.append('image[]', file);
  }
  return { type: 'ok', form };
};

// Codex's client-owned image extension posts JSON to provider-relative paths;
// the public OpenAI edits route remains multipart/form-data.
// https://github.com/openai/codex/blob/f90e7deea6a715bbd153044af6f475eefa749177/codex-rs/codex-api/src/endpoint/images.rs#L33-L68
// https://github.com/openai/codex/blob/f90e7deea6a715bbd153044af6f475eefa749177/codex-rs/codex-api/src/images.rs#L4-L31
export const codexImagesEdits = async (c: Context): Promise<Response> => {
  const requestBody = await readRequestBody(c);
  const prepared = prepareCodexImageEdit(requestBody.bytes);
  if (prepared.type === 'invalid') return invalidRequest(c, requestBody, prepared.message);
  return await serveImagesEditForm(c, requestBody, prepared.form);
};
