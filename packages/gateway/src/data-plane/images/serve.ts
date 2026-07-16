// POST /v1/images/generations and POST /v1/images/edits — route image
// requests to the provider that declares the requested model and the
// matching image endpoint capability.
//
// The edits handler accepts multipart uploads and JSON `images` references.
// Both are buffered once for dump capture and normalized into a semantic
// request; each provider owns the final JSON or multipart serialization.
// https://github.com/openai/openai-openapi/blob/a3276900e58b8b2a92e0cb087cd2e6e005f58458/openapi.yaml#L12558-L12620

import type { Context } from 'hono';

import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import { createGatewayCtxFromHono, finalizeGatewayResponse } from '../chat/shared/gateway-ctx.ts';
import { readRequestBody, takeRequestBody, type RequestBody } from '../chat/shared/request-body.ts';
import { passthroughApiError, passthroughServe } from '../shared/passthrough-serve.ts';
import { tokenUsageFromImagesBody } from '../shared/telemetry/usage.ts';
import type { ImageEditReference } from '@floway-dev/protocols/images';
import { isBase64ImageDataUrl, type ImagesEditsRequest, type ImagesEditsSource } from '@floway-dev/provider';

interface JsonModelRequestBody {
  model?: unknown;
  [key: string]: unknown;
}

type PreparedJsonRequest =
  | { type: 'ok'; body: Record<string, unknown>; model: string }
  | { type: 'invalid'; message: string };

const prepareJsonModelRequest = (bytes: Uint8Array, requestName: string): PreparedJsonRequest => {
  let request: JsonModelRequestBody;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { type: 'invalid', message: `${requestName} request body must be an object.` };
    }
    request = parsed as JsonModelRequestBody;
  } catch {
    return { type: 'invalid', message: `${requestName} request body must be valid JSON.` };
  }
  if (typeof request.model !== 'string' || request.model.length === 0) {
    return { type: 'invalid', message: `${requestName} request body must include a model string.` };
  }
  return { type: 'ok', body: request as Record<string, unknown>, model: request.model };
};

type PreparedImagesEdit =
  | { type: 'ok'; request: ImagesEditsRequest }
  | { type: 'invalid'; message: string };

const imageEditSource = (value: unknown, path: string): ImagesEditsSource | string => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return `${path} must be an object.`;
  }
  const reference = value as { image_url?: unknown; file_id?: unknown };
  const { image_url: imageUrl, file_id: fileId } = reference;
  if (typeof imageUrl === 'string' && fileId === undefined) {
    const imageReference = reference as ImageEditReference & { image_url: string };
    return isBase64ImageDataUrl(imageUrl)
      ? { type: 'inline', reference: imageReference }
      : { type: 'reference', reference: imageReference };
  }
  if (typeof fileId === 'string' && imageUrl === undefined) {
    return { type: 'reference', reference: reference as ImageEditReference };
  }
  return `${path} must contain exactly one string field: image_url or file_id.`;
};

const prepareJsonImagesEdit = (body: Record<string, unknown>): PreparedImagesEdit => {
  if (!Array.isArray(body.images)) {
    return { type: 'invalid', message: 'Image edits request body must include an images array.' };
  }
  const images: ImagesEditsSource[] = [];
  for (const [index, value] of body.images.entries()) {
    const source = imageEditSource(value, `Image edits images[${index}]`);
    if (typeof source === 'string') return { type: 'invalid', message: source };
    images.push(source);
  }
  let mask: ImagesEditsSource | undefined;
  if (body.mask !== undefined) {
    const source = imageEditSource(body.mask, 'Image edits mask');
    if (typeof source === 'string') return { type: 'invalid', message: source };
    mask = source;
  }
  const { model: _model, images: _images, mask: _mask, ...parameters } = body;
  return {
    type: 'ok',
    request: {
      images,
      ...(mask === undefined ? {} : { mask }),
      parameters,
    },
  };
};

export const imagesGenerations = async (c: Context): Promise<Response> => {
  const requestBody = await readRequestBody(c);
  const request = prepareJsonModelRequest(requestBody.bytes, 'Images generations');
  const ctx = createGatewayCtxFromHono(c, { wantsStream: false, requestBody: takeRequestBody(requestBody), backgroundScheduler: backgroundSchedulerFromContext(c) });
  if (request.type === 'invalid') {
    ctx.dump?.error('gateway');
    return finalizeGatewayResponse(ctx, passthroughApiError(c, request.message, 400));
  }

  ctx.dump?.requestedModel(request.model);
  const response = await passthroughServe({
    c,
    ctx,
    sourceApi: '/images/generations',
    operation: 'image_generation',
    model: request.model,
    kind: 'image',
    modelServesEndpoint: model => model.endpoints.imagesGenerations !== undefined,
    call: (provider, model, opts) => {
      const { model: _model, ...body } = request.body;
      return provider.instance.callImagesGenerations(model, body, undefined, opts);
    },
    response: { format: 'json', extractBilling: tokenUsageFromImagesBody },
  });
  return finalizeGatewayResponse(ctx, response);
};

const serveImagesEditRequest = async (
  c: Context,
  requestBody: RequestBody,
  model: string,
  request: ImagesEditsRequest,
): Promise<Response> => {
  const ctx = createGatewayCtxFromHono(c, { wantsStream: false, requestBody: takeRequestBody(requestBody), backgroundScheduler: backgroundSchedulerFromContext(c) });
  ctx.dump?.requestedModel(model);
  const response = await passthroughServe({
    c,
    ctx,
    sourceApi: '/images/edits',
    operation: 'image_edit',
    model,
    kind: 'image',
    modelServesEndpoint: model => model.endpoints.imagesEdits !== undefined,
    call: (provider, model, opts) => provider.instance.callImagesEdits(model, request, undefined, opts),
    response: { format: 'json', extractBilling: tokenUsageFromImagesBody },
  });
  return finalizeGatewayResponse(ctx, response);
};

export const imagesEdits = async (c: Context): Promise<Response> => {
  const requestBody = await readRequestBody(c);
  const invalid = (message: string): Response => {
    const errorCtx = createGatewayCtxFromHono(c, { wantsStream: false, requestBody: takeRequestBody(requestBody), backgroundScheduler: backgroundSchedulerFromContext(c) });
    errorCtx.dump?.error('gateway');
    return finalizeGatewayResponse(errorCtx, passthroughApiError(c, message, 400));
  };

  const contentType = c.req.header('content-type');
  if (contentType === undefined) {
    return invalid('Image edits request body must use application/json or multipart/form-data.');
  }
  const mediaType = contentType.replace(/;.*$/u, '').trim().toLowerCase();
  if (mediaType === 'application/json') {
    const body = prepareJsonModelRequest(requestBody.bytes, 'Image edits');
    if (body.type === 'invalid') return invalid(body.message);
    const request = prepareJsonImagesEdit(body.body);
    if (request.type === 'invalid') return invalid(request.message);
    return await serveImagesEditRequest(c, requestBody, body.model, request.request);
  }

  if (mediaType !== 'multipart/form-data') {
    return invalid('Image edits request body must use application/json or multipart/form-data.');
  }
  let form: FormData;
  try {
    form = await new Response(requestBody.bytes as BodyInit, { headers: { 'content-type': contentType } }).formData();
  } catch {
    return invalid('Image edits request body must be valid multipart/form-data.');
  }
  const model = form.get('model');
  if (typeof model !== 'string' || model.length === 0) {
    return invalid('Image edits request body must include a model field.');
  }
  const images: File[] = [];
  let mask: File | undefined;
  const parameters: Record<string, string | number | boolean> = {};
  for (const [name, value] of form.entries()) {
    if (name === 'model') continue;
    if (name === 'image' || name === 'image[]') {
      if (!(value instanceof File)) return invalid(`Image edits ${name} fields must be files.`);
      images.push(value);
    } else if (name === 'mask') {
      if (!(value instanceof File)) return invalid('Image edits mask field must be a file.');
      mask = value;
    } else {
      if (typeof value !== 'string') return invalid(`Image edits ${name} field must be text.`);
      parameters[name] = value;
    }
  }
  return await serveImagesEditRequest(c, requestBody, model, {
    images: images.map(file => ({ type: 'upload', file })),
    ...(mask === undefined ? {} : { mask: { type: 'upload' as const, file: mask } }),
    parameters,
  });
};
