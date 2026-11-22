import { rerankPipeline, type RerankPipelineInput } from './pipeline.ts';
import type { AuthedContext } from '../../middleware/auth.ts';
import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import { buildDownstreamWireUrl, inboundHeaderEntriesFromHono, runGatewayHttpPipeline } from '../pipeline/index.ts';
import { createGatewayCtxFromHono, finalizeGatewayResponse } from '../shared/gateway-ctx.ts';
import { readRequestBody, takeRequestBody } from '../shared/request-body.ts';
import type { RerankSourceProtocol } from '@floway-dev/protocols/common';
import { parseRerankRequest, type ParsedRerankRequest } from '@floway-dev/protocols/rerank';

const apiError = (c: AuthedContext, message: string): Response =>
  c.json({ error: { message, type: 'api_error' } }, 400);

const parseJson = (bytes: Uint8Array): unknown => {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new Error('Rerank request body must be valid JSON');
  }
};

export const rerank = (sourceProtocol: RerankSourceProtocol) => async (c: AuthedContext): Promise<Response> => {
  const requestBody = await readRequestBody(c);
  let parsedRequest: ParsedRerankRequest;
  try {
    parsedRequest = parseRerankRequest(sourceProtocol, parseJson(requestBody.bytes));
  } catch (error) {
    const ctx = createGatewayCtxFromHono(c, {
      wantsStream: false,
      requestBody: takeRequestBody(requestBody),
      backgroundScheduler: backgroundSchedulerFromContext(c),
    });
    ctx.dump?.error('gateway');
    return finalizeGatewayResponse(ctx, apiError(c, error instanceof Error ? error.message : String(error)));
  }

  const { model, request } = parsedRequest;
  const ctx = createGatewayCtxFromHono(c, {
    wantsStream: false,
    model,
    requestBody: takeRequestBody(requestBody),
    backgroundScheduler: backgroundSchedulerFromContext(c),
  });
  const inboundHeaders = inboundHeaderEntriesFromHono(c);
  const input: RerankPipelineInput = {
    'request.http': {
      method: c.req.method,
      url: buildDownstreamWireUrl(c.req.url),
      headers: inboundHeaders,
      body: request.raw,
      protocol: sourceProtocol,
    },
    'request.inboundHeaders': inboundHeaders,
    'request.model': model,
    'request.payload': request,
  };
  return await runGatewayHttpPipeline(c, ctx, rerankPipeline(sourceProtocol), input);
};
