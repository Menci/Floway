// POST /v1/embeddings — route embedding requests to the provider that
// declares the requested model and OpenAI Embeddings capability.

import type { Context } from 'hono';

import { openaiEmbeddingsPipeline } from './pipeline.ts';
import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import {
  buildDownstreamWireUrl,
  createGatewayPipelineServices,
  inboundHeaderEntriesFromHono,
  runGatewayHttpPipeline,
} from '../pipeline/index.ts';
import { createGatewayCtxFromHono, finalizeGatewayResponse } from '../shared/gateway-ctx.ts';
import { prepareJsonModelRequest } from '../shared/passthrough-request.ts';
import { readRequestBody, takeRequestBody } from '../shared/request-body.ts';

export const openaiEmbeddings = async (c: Context): Promise<Response> => {
  const requestBody = await readRequestBody(c);
  const request = prepareJsonModelRequest(requestBody.bytes, 'OpenAI Embeddings');
  const ctx = createGatewayCtxFromHono(c, {
    wantsStream: false,
    requestBody: takeRequestBody(requestBody),
    backgroundScheduler: backgroundSchedulerFromContext(c),
  });
  if (request.type === 'invalid') {
    ctx.dump?.error('gateway');
    return finalizeGatewayResponse(ctx, Response.json(
      { error: { message: request.message, type: 'api_error' } },
      { status: 400 },
    ));
  }

  const services = createGatewayPipelineServices(ctx);
  services.attribution.recordRequestedModel(request.model);
  const { model: _model, ...payload } = request.body;
  const inboundHeaders = inboundHeaderEntriesFromHono(c);
  return await runGatewayHttpPipeline(c, ctx, openaiEmbeddingsPipeline, {
    'request.http': {
      method: c.req.method,
      url: buildDownstreamWireUrl(c.req.url),
      headers: inboundHeaders,
      body: { kind: 'json', value: request.body },
      protocol: 'openai-embeddings',
    },
    'request.inboundHeaders': inboundHeaders,
    'request.model': request.model,
    'request.payload': payload,
  }, { services });
};
