// POST /v1/images/generations and POST /v1/images/edits — route image
// requests to the provider that declares the requested model and the
// matching image endpoint capability.
//
// The edits handler accepts multipart uploads and JSON `images` references.
// Both shapes are buffered once for dump capture; JSON remains JSON through
// provider dispatch, while multipart is re-encoded with a fresh boundary.
// https://github.com/openai/openai-openapi/blob/a3276900e58b8b2a92e0cb087cd2e6e005f58458/openapi.yaml#L12558-L12620
// A streaming parser is required before unbounded multipart uploads are viable.

import type { Context } from 'hono';

import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import { createGatewayCtxFromHono, finalizeGatewayResponse } from '../chat/shared/gateway-ctx.ts';
import { readRequestBody, takeRequestBody, type RequestBody } from '../chat/shared/request-body.ts';
import { passthroughApiError, passthroughServe } from '../shared/passthrough-serve.ts';
import { tokenUsageFromImagesBody } from '../shared/telemetry/usage.ts';
import type { ImagesEditsJsonPayload } from '@floway-dev/protocols/images';
import type { ImagesEditsBody } from '@floway-dev/provider';

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

const serveImagesEditBody = async (
  c: Context,
  requestBody: RequestBody,
  model: string,
  body: ImagesEditsBody,
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
    call: (provider, model, opts) => {
      if (!(body instanceof FormData)) {
        return provider.instance.callImagesEdits(model, body, undefined, opts);
      }
      // The provider may append its model id to multipart bodies, so allocate
      // a fresh FormData per candidate. Blob values remain shared.
      const candidateBody = new FormData();
      for (const [name, value] of body.entries()) {
        if (name !== 'model') candidateBody.append(name, value);
      }
      return provider.instance.callImagesEdits(model, candidateBody, undefined, opts);
    },
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
    const request = prepareJsonModelRequest(requestBody.bytes, 'Image edits');
    if (request.type === 'invalid') return invalid(request.message);
    const { model: _model, ...body } = request.body as ImagesEditsJsonPayload;
    return await serveImagesEditBody(c, requestBody, request.model, body);
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
  return await serveImagesEditBody(c, requestBody, model, form);
};
