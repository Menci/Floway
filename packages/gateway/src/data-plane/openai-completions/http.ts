// POST /v1/completions and /completions - OpenAI Completions passthrough.
// The handler parses the request only far enough to open the pipeline with
// the endpoint's routing and stream-shape facts; the stages own routing,
// failover, billing, and response rendering.

import type { Context } from 'hono';

import { openaiCompletionsPipeline } from './pipeline.ts';
import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import { buildDownstreamWireUrl, inboundHeaderEntriesFromHono, runGatewayHttpPipeline } from '../pipeline/index.ts';
import { createGatewayCtxFromHono, finalizeGatewayResponse } from '../shared/gateway-ctx.ts';
import { prepareJsonModelRequest } from '../shared/passthrough-request.ts';
import { readRequestBody, takeRequestBody } from '../shared/request-body.ts';
import type { OpenAICompletionsPayload } from '@floway-dev/protocols/openai-completions';

export const openaiCompletions = async (c: Context): Promise<Response> => {
  const requestBody = await readRequestBody(c);
  const request = prepareJsonModelRequest(requestBody.bytes, 'OpenAI Completions');
  // `stream` decides the response shape, so the gateway context has to learn
  // it before the invalid branch — which has no body to read it from.
  const wantsStream = request.type === 'ok' && request.body.stream === true;
  const ctx = createGatewayCtxFromHono(c, {
    wantsStream,
    requestBody: takeRequestBody(requestBody),
    backgroundScheduler: backgroundSchedulerFromContext(c),
  });
  if (request.type === 'invalid') {
    ctx.dump?.error('gateway');
    return finalizeGatewayResponse(
      ctx,
      c.json({ error: { message: request.message, type: 'api_error' } }, 400),
    );
  }

  const streamOptions = request.body.stream_options as { include_usage?: unknown } | null | undefined;
  ctx.dump?.requestedModel(request.model);
  return await runGatewayHttpPipeline(c, ctx, openaiCompletionsPipeline, {
    'request.http': {
      method: c.req.method,
      url: buildDownstreamWireUrl(c.req.url),
      headers: inboundHeaderEntriesFromHono(c),
      body: request.body,
      protocol: '/completions',
    },
    'request.inboundHeaders': inboundHeaderEntriesFromHono(c),
    'request.model': request.model,
    'request.payload': request.body as OpenAICompletionsPayload,
    'request.wantsStream': wantsStream,
    'request.wantsUsageChunk': streamOptions?.include_usage === true,
  });
};
