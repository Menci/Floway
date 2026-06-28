// POST /v1/images/generations and POST /v1/images/edits — route image
// requests to the provider that declares the requested model and the
// matching image endpoint capability.
//
// Edits multipart bodies are loaded into memory via `request.formData()`;
// this caps the per-request body size at the Workers heap (~128 MB).
// Sufficient for the gpt-image-2 single-image edit case (≤50 MB image +
// ≤50 MB mask). Multi-image edits with the gpt-image-1 `image[]` array
// may exceed the heap — a streaming multipart parser is a follow-up.

import type { Context } from 'hono';

import { createGatewayCtxFromHono } from '../chat/shared/gateway-ctx.ts';
import { readRequestBody } from '../chat/shared/request-body.ts';
import { passthroughApiError, passthroughServe } from '../shared/passthrough-serve.ts';
import { tokenUsageFromImagesBody } from '../shared/telemetry/usage.ts';

interface ImagesGenerationsRequestBody {
  model?: unknown;
  prompt?: unknown;
  [key: string]: unknown;
}

type PreparedRequest =
  | { type: 'ok'; body: Record<string, unknown>; model: string }
  | { type: 'invalid'; message: string };

const prepareImagesGenerationsRequest = (bytes: Uint8Array): PreparedRequest => {
  let request: ImagesGenerationsRequestBody;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { type: 'invalid', message: 'Images generations request body must be an object.' };
    }
    request = parsed as ImagesGenerationsRequestBody;
  } catch {
    return { type: 'invalid', message: 'Images generations request body must be valid JSON.' };
  }
  if (typeof request.model !== 'string' || request.model.length === 0) {
    return { type: 'invalid', message: 'Images generations request body must include a model string.' };
  }
  return { type: 'ok', body: request as Record<string, unknown>, model: request.model };
};

export const imagesGenerations = async (c: Context): Promise<Response> => {
  const requestBody = await readRequestBody(c);
  const ctx = createGatewayCtxFromHono(c, { wantsStream: false, requestBody });
  const request = prepareImagesGenerationsRequest(requestBody.bytes);
  if (request.type === 'invalid') {
    ctx.dump?.error('gateway');
    const response = passthroughApiError(c, request.message, 400);
    return (ctx.dump?.finalize(response) ?? response);
  }

  ctx.dump?.requestedModel(request.model);
  const response = await passthroughServe({
    c,
    ctx,
    sourceApi: '/images/generations',
    model: request.model,
    kind: 'image',
    modelServesEndpoint: model => model.endpoints.imagesGenerations !== undefined,
    call: (provider, model, opts) => {
      const { model: _model, ...body } = request.body;
      return provider.provider.callImagesGenerations(model, body, undefined, opts);
    },
    response: { format: 'json', extractBilling: tokenUsageFromImagesBody },
  });
  return (ctx.dump?.finalize(response) ?? response);
};

export const imagesEdits = async (c: Context): Promise<Response> => {
  // Buffer the multipart body once. Hono's formData() helper would consume
  // c.req.raw.body internally; re-parsing from the captured bytes via a fresh
  // Response keeps the dump capture honest without a second read on the wire.
  const requestBody = await readRequestBody(c);
  const ctx = createGatewayCtxFromHono(c, { wantsStream: false, requestBody });
  let form: FormData;
  try {
    form = await new Response(requestBody.bytes as BodyInit, { headers: { 'content-type': c.req.header('content-type') ?? '' } }).formData();
  } catch {
    // Match the embeddings serve stance: do not surface the underlying
    // parser's error text. The wording is enough for a client to know
    // they sent the wrong content type or a malformed body.
    ctx.dump?.error('gateway');
    const response = passthroughApiError(c, 'Image edits request body must be a valid multipart/form-data payload.', 400);
    return (ctx.dump?.finalize(response) ?? response);
  }

  const modelRaw = form.get('model');
  if (typeof modelRaw !== 'string' || modelRaw.length === 0) {
    ctx.dump?.error('gateway');
    const response = passthroughApiError(c, 'Image edits request body must include a model field.', 400);
    return (ctx.dump?.finalize(response) ?? response);
  }

  ctx.dump?.requestedModel(modelRaw);
  const response = await passthroughServe({
    c,
    ctx,
    sourceApi: '/images/edits',
    model: modelRaw,
    kind: 'image',
    modelServesEndpoint: model => model.endpoints.imagesEdits !== undefined,
    call: (provider, model, opts) => {
      // ModelProvider.callImagesEdits takes ownership of the FormData and
      // appends the upstream-specific model/deployment id; allocate a fresh
      // copy per candidate so the contract holds even if cross-candidate
      // fallback is ever extended to try a second match. File-blob entries
      // are passed by reference so no buffer copy happens.
      const passthrough = new FormData();
      for (const [name, value] of form.entries()) {
        if (name === 'model') continue;
        passthrough.append(name, value);
      }
      return provider.provider.callImagesEdits(model, passthrough, undefined, opts);
    },
    response: { format: 'json', extractBilling: tokenUsageFromImagesBody },
  });
  return (ctx.dump?.finalize(response) ?? response);
};
