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

import { passthroughApiError, passthroughServe } from '../shared/passthrough-serve.ts';
import { tokenUsageFromImagesResponse } from '../shared/telemetry/usage.ts';

interface ImagesGenerationsRequestBody {
  model?: unknown;
  prompt?: unknown;
  [key: string]: unknown;
}

type PreparedRequest =
  | { type: 'ok'; body: Record<string, unknown>; model: string }
  | { type: 'invalid'; message: string };

const prepareImagesGenerationsRequest = (body: string): PreparedRequest => {
  let request: ImagesGenerationsRequestBody;
  try {
    const parsed = JSON.parse(body) as unknown;
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
  const request = prepareImagesGenerationsRequest(await c.req.text());
  if (request.type === 'invalid') return passthroughApiError(c, request.message, 400);

  return await passthroughServe({
    c,
    sourceApi: 'images_generations',
    model: request.model,
    bindingServesEndpoint: binding => binding.upstreamModel.upstreamEndpoints.includes('images_generations'),
    call: binding => {
      const { model: _model, ...body } = request.body;
      return binding.provider.callImagesGenerations(binding.upstreamModel, body);
    },
    extractUsage: tokenUsageFromImagesResponse,
    noBindingMessage: modelId => `Model ${modelId} does not support the /images/generations endpoint.`,
  });
};

export const imagesEdits = async (c: Context): Promise<Response> => {
  let form: FormData;
  try {
    form = await c.req.raw.formData();
  } catch {
    // Match the embeddings serve stance: do not surface the underlying
    // parser's error text. The wording is enough for a client to know
    // they sent the wrong content type or a malformed body.
    return passthroughApiError(c, 'Image edits request body must be a valid multipart/form-data payload.', 400);
  }

  const modelRaw = form.get('model');
  if (typeof modelRaw !== 'string' || modelRaw.length === 0) {
    return passthroughApiError(c, 'Image edits request body must include a model field.', 400);
  }

  return await passthroughServe({
    c,
    sourceApi: 'images_edits',
    model: modelRaw,
    bindingServesEndpoint: binding => binding.upstreamModel.upstreamEndpoints.includes('images_edits'),
    call: binding => {
      // ModelProvider.callImagesEdits takes ownership of the FormData and
      // appends the upstream-specific model/deployment id; allocate a fresh
      // copy per binding so the contract holds even if cross-binding
      // fallback is ever extended to try a second binding. File-blob entries
      // are passed by reference so no buffer copy happens.
      const passthrough = new FormData();
      for (const [name, value] of form.entries()) {
        if (name === 'model') continue;
        passthrough.append(name, value);
      }
      return binding.provider.callImagesEdits(binding.upstreamModel, passthrough);
    },
    extractUsage: tokenUsageFromImagesResponse,
    noBindingMessage: modelId => `Model ${modelId} does not support the /images/edits endpoint.`,
  });
};
