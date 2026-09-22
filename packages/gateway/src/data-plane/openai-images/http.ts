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
import { createGatewayCtxFromHono, finalizeGatewayResponse } from '../shared/gateway-ctx.ts';
import { prepareJsonModelRequest } from '../shared/passthrough-request.ts';
import { passthroughApiError, passthroughServe } from '../shared/passthrough-serve.ts';
import { readRequestBody, takeRequestBody, type RequestBody } from '../shared/request-body.ts';
import { tokenUsageFromOpenAIImagesBody } from '../shared/telemetry/usage.ts';
import { isJsonMediaType, isMultipartFormDataMediaType } from '@floway-dev/protocols/common';
import type { OpenAIImageEditReference } from '@floway-dev/protocols/openai-images';
import { isBase64ImageDataUrl, type OpenAIImagesEditsRequest, type OpenAIImagesEditsSource } from '@floway-dev/provider';

type PreparedOpenAIImagesEdit =
  | { type: 'ok'; request: OpenAIImagesEditsRequest }
  | { type: 'invalid'; message: string };

const openaiImageEditSource = (value: unknown, path: string): OpenAIImagesEditsSource | string => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return `${path} must be an object.`;
  }
  const reference = value as { image_url?: unknown; file_id?: unknown };
  const { image_url: imageUrl, file_id: fileId } = reference;
  if (typeof imageUrl === 'string' && fileId === undefined) {
    const imageReference = reference as OpenAIImageEditReference & { image_url: string };
    return isBase64ImageDataUrl(imageUrl)
      ? { type: 'inline', reference: imageReference }
      : { type: 'reference', reference: imageReference };
  }
  if (typeof fileId === 'string' && imageUrl === undefined) {
    return { type: 'reference', reference: reference as OpenAIImageEditReference };
  }
  return `${path} must contain exactly one string field: image_url or file_id.`;
};

const prepareJsonOpenAIImagesEdit = (body: Record<string, unknown>): PreparedOpenAIImagesEdit => {
  if (!Array.isArray(body.images)) {
    return { type: 'invalid', message: 'OpenAI Images Edits request body must include an images array.' };
  }
  const images: OpenAIImagesEditsSource[] = [];
  for (const [index, value] of body.images.entries()) {
    const source = openaiImageEditSource(value, `OpenAI Images Edits images[${index}]`);
    if (typeof source === 'string') return { type: 'invalid', message: source };
    images.push(source);
  }
  let mask: OpenAIImagesEditsSource | undefined;
  if (body.mask !== undefined) {
    const source = openaiImageEditSource(body.mask, 'OpenAI Images Edits mask');
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

export const openaiImagesGenerations = async (c: Context): Promise<Response> => {
  const requestBody = await readRequestBody(c);
  const request = prepareJsonModelRequest(requestBody.bytes, 'OpenAI Images Generations');
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
    modelServesEndpoint: model => model.endpoints.openaiImagesGenerations !== undefined,
    call: (provider, model, opts) => {
      const { model: _model, ...body } = request.body;
      return provider.instance.callOpenAIImagesGenerations(model, body, undefined, opts);
    },
    response: { format: 'json', extractBilling: tokenUsageFromOpenAIImagesBody },
  });
  return finalizeGatewayResponse(ctx, response);
};

const serveOpenAIImagesEditRequest = async (
  c: Context,
  requestBody: RequestBody,
  model: string,
  request: OpenAIImagesEditsRequest,
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
    modelServesEndpoint: model => model.endpoints.openaiImagesEdits !== undefined,
    call: (provider, model, opts) => provider.instance.callOpenAIImagesEdits(model, request, undefined, opts),
    response: { format: 'json', extractBilling: tokenUsageFromOpenAIImagesBody },
  });
  return finalizeGatewayResponse(ctx, response);
};

export const openaiImagesEdits = async (c: Context): Promise<Response> => {
  const requestBody = await readRequestBody(c);
  const invalid = (message: string): Response => {
    const errorCtx = createGatewayCtxFromHono(c, { wantsStream: false, requestBody: takeRequestBody(requestBody), backgroundScheduler: backgroundSchedulerFromContext(c) });
    errorCtx.dump?.error('gateway');
    return finalizeGatewayResponse(errorCtx, passthroughApiError(c, message, 400));
  };

  const contentType = c.req.header('content-type');
  if (contentType === undefined) {
    return invalid('OpenAI Images Edits request body must use application/json or multipart/form-data.');
  }
  if (isJsonMediaType(contentType)) {
    const body = prepareJsonModelRequest(requestBody.bytes, 'OpenAI Images Edits');
    if (body.type === 'invalid') return invalid(body.message);
    const request = prepareJsonOpenAIImagesEdit(body.body);
    if (request.type === 'invalid') return invalid(request.message);
    return await serveOpenAIImagesEditRequest(c, requestBody, body.model, request.request);
  }

  if (!isMultipartFormDataMediaType(contentType)) {
    return invalid('OpenAI Images Edits request body must use application/json or multipart/form-data.');
  }
  let form: FormData;
  try {
    form = await new Response(requestBody.bytes as BodyInit, { headers: { 'content-type': contentType } }).formData();
  } catch {
    return invalid('OpenAI Images Edits request body must be valid multipart/form-data.');
  }
  const model = form.get('model');
  if (typeof model !== 'string' || model.length === 0) {
    return invalid('OpenAI Images Edits request body must include a model field.');
  }
  const images: File[] = [];
  let mask: File | undefined;
  const parameters: Record<string, string | number | boolean> = {};
  for (const [name, value] of form.entries()) {
    if (name === 'model') continue;
    if (name === 'image' || name === 'image[]') {
      if (!(value instanceof File)) return invalid(`OpenAI Images Edits ${name} fields must be files.`);
      images.push(value);
    } else if (name === 'mask') {
      if (!(value instanceof File)) return invalid('OpenAI Images Edits mask field must be a file.');
      mask = value;
    } else {
      if (typeof value !== 'string') return invalid(`OpenAI Images Edits ${name} field must be text.`);
      parameters[name] = value;
    }
  }
  return await serveOpenAIImagesEditRequest(c, requestBody, model, {
    images: images.map(file => ({ type: 'upload', file })),
    ...(mask === undefined ? {} : { mask: { type: 'upload' as const, file: mask } }),
    parameters,
  });
};
