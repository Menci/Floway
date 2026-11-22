import { decisionPipeline, type DecisionPipelineInput } from './pipeline.ts';
import type { AuthedContext } from '../../middleware/auth.ts';
import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import { buildDownstreamWireUrl, inboundHeaderEntriesFromHono, runGatewayHttpPipeline } from '../pipeline/index.ts';
import { createGatewayCtxFromHono, finalizeGatewayResponse } from '../shared/gateway-ctx.ts';
import { readRequestBody, takeRequestBody } from '../shared/request-body.ts';
import { parseJSONWithRawNumbers, type DecisionProtocol } from '@floway-dev/protocols/common';
import { parseDecisionRequest, type ParsedDecisionRequest } from '@floway-dev/protocols/decision';

const apiError = (c: AuthedContext, message: string): Response =>
  c.json({ error: { message, type: 'api_error' } }, 400);

// Raw-number parsing keeps a caller's own digits — a same-dialect forward
// re-emits `raw` verbatim, so parsing to a number first would rewrite them.
const parseJson = (bytes: Uint8Array): unknown => {
  try {
    return parseJSONWithRawNumbers(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('Decision request body must be valid JSON');
  }
};

export const decision = (sourceProtocol: DecisionProtocol) => async (c: AuthedContext): Promise<Response> => {
  const requestBody = await readRequestBody(c);
  let parsedRequest: ParsedDecisionRequest;
  try {
    parsedRequest = parseDecisionRequest(sourceProtocol, parseJson(requestBody.bytes));
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
  const input: DecisionPipelineInput = {
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
  return await runGatewayHttpPipeline(c, ctx, decisionPipeline(sourceProtocol), input);
};
