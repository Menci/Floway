// POST /v1/embeddings — route embedding requests to the provider that
// declares the requested model and embeddings capability.

import type { Context } from 'hono';

import { passthroughApiError, passthroughServe } from '../shared/passthrough-serve.ts';
import { tokenUsageFromPromptTokenResponse } from '../shared/telemetry/usage.ts';

interface EmbeddingsRequestBody {
  model?: unknown;
  input?: unknown;
  [key: string]: unknown;
}

const prepareEmbeddingsRequest = (body: string): { type: 'ok'; body: Record<string, unknown>; model: string } | { type: 'invalid'; message: string } => {
  let request: EmbeddingsRequestBody;

  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        type: 'invalid',
        message: 'Embeddings request body must be an object.',
      };
    }
    request = parsed as EmbeddingsRequestBody;
  } catch {
    return {
      type: 'invalid',
      message: 'Embeddings request body must be valid JSON.',
    };
  }

  if (typeof request.model !== 'string' || request.model.length === 0) {
    return {
      type: 'invalid',
      message: 'Embeddings request body must include a model string.',
    };
  }

  return { type: 'ok', body: request, model: request.model };
};

export const embeddings = async (c: Context): Promise<Response> => {
  const request = prepareEmbeddingsRequest(await c.req.text());
  if (request.type === 'invalid') return passthroughApiError(c, request.message, 400);

  return await passthroughServe({
    c,
    sourceApi: 'embeddings',
    model: request.model,
    bindingServesEndpoint: binding => binding.upstreamModel.kind === 'embedding',
    call: async binding => {
      const { model: _model, ...body } = request.body;
      return await binding.provider.callEmbeddings(binding.upstreamModel, body);
    },
    extractUsage: tokenUsageFromPromptTokenResponse,
    noBindingMessage: modelId => `Model ${modelId} does not support the /embeddings endpoint.`,
  });
};
