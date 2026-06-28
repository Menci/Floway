// POST /v1/embeddings — route embedding requests to the provider that
// declares the requested model and embeddings capability.

import type { Context } from 'hono';

import { createGatewayCtxFromHono } from '../chat/shared/gateway-ctx.ts';
import { readRequestBody } from '../chat/shared/request-body.ts';
import { passthroughApiError, passthroughServe } from '../shared/passthrough-serve.ts';
import { tokenUsageFromEmbeddingsBody } from '../shared/telemetry/usage.ts';

interface EmbeddingsRequestBody {
  model?: unknown;
  input?: unknown;
  [key: string]: unknown;
}

const prepareEmbeddingsRequest = (bytes: Uint8Array): { type: 'ok'; body: Record<string, unknown>; model: string } | { type: 'invalid'; message: string } => {
  let request: EmbeddingsRequestBody;

  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
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
  const requestBody = await readRequestBody(c);
  const ctx = createGatewayCtxFromHono(c, { wantsStream: false, requestBody });
  const request = prepareEmbeddingsRequest(requestBody.bytes);
  if (request.type === 'invalid') {
    ctx.dump?.error('gateway');
    const response = passthroughApiError(c, request.message, 400);
    return (ctx.dump?.finalize(response) ?? response);
  }

  ctx.dump?.requestedModel(request.model);
  const response = await passthroughServe({
    c,
    ctx,
    sourceApi: '/embeddings',
    model: request.model,
    kind: 'embedding',
    modelServesEndpoint: model => model.endpoints.embeddings !== undefined,
    call: async (provider, model, opts) => {
      const { model: _model, ...body } = request.body;
      return await provider.provider.callEmbeddings(model, body, undefined, opts);
    },
    response: { format: 'json', extractBilling: tokenUsageFromEmbeddingsBody },
  });
  return (ctx.dump?.finalize(response) ?? response);
};
