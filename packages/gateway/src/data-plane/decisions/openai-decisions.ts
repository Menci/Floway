// POST /v1/decisions — OpenAI Decisions. Decision models reach Floway only
// through System One upstreams, so the request is lowered onto System One and
// the System One answer map is rendered back as OpenAI's ordered answers.
// https://developers.openai.com/api/reference/resources/decisions/methods/create

import type { Context } from 'hono';

import { tokenUsageFromSystemOneBody } from './usage.ts';
import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import { createGatewayCtxFromHono, finalizeGatewayResponse } from '../shared/gateway-ctx.ts';
import { passthroughServe, type PassthroughResponseStrategyContext } from '../shared/passthrough-serve.ts';
import { readRequestBody, takeRequestBody } from '../shared/request-body.ts';
import { recordFailedRequest } from '../shared/telemetry/performance.ts';
import { settle } from '../shared/telemetry/settle.ts';
import { forwardUpstreamResponse } from '../shared/upstream-response.ts';
import { DecisionsRequestError, renderDecisionsResponse, translateDecisionsRequest, type DecisionsQuestionPlan, type DecisionsTranslation } from '@floway-dev/protocols/decisions';
import { toInternalDebugError } from '@floway-dev/provider';

const invalidRequest = (c: Context, message: string, param: string | null): Response =>
  c.json({ error: { message, type: 'invalid_request_error', param } }, 400);

const parseRequest = (bytes: Uint8Array): DecisionsTranslation | DecisionsRequestError => {
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return new DecisionsRequestError('Decisions request body must be valid JSON.', null);
  }
  try {
    return translateDecisionsRequest(body);
  } catch (error) {
    if (error instanceof DecisionsRequestError) return error;
    throw error;
  }
};

// Upstream failures keep their own status, headers, and body. A 2xx is billed
// before rendering, since the upstream metered it whether or not its answers
// can be lifted back into the OpenAI shape.
const respondDecisions = (questions: readonly DecisionsQuestionPlan[]) => async ({ c, ctx, response, performance, identity }: PassthroughResponseStrategyContext): Promise<Response> => {
  if (!response.ok) {
    recordFailedRequest(ctx, performance);
    ctx.dump?.error('upstream', identity.upstream);
    return forwardUpstreamResponse(response);
  }
  const body = await response.json() as unknown;
  const usage = tokenUsageFromSystemOneBody(body);
  let rendered: Record<string, unknown>;
  try {
    rendered = renderDecisionsResponse(body, questions);
  } catch (error) {
    ctx.dump?.failed(error);
    settle(ctx, performance, identity, usage, true);
    return c.json({ error: toInternalDebugError(error) }, 502);
  }
  ctx.dump?.success(identity, usage);
  settle(ctx, performance, identity, usage, false);
  return forwardUpstreamResponse(response, { body: JSON.stringify(rendered) });
};

export const openaiDecisions = async (c: Context): Promise<Response> => {
  const requestBody = await readRequestBody(c);
  const request = parseRequest(requestBody.bytes);
  const ctx = createGatewayCtxFromHono(c, { wantsStream: false, requestBody: takeRequestBody(requestBody), backgroundScheduler: backgroundSchedulerFromContext(c) });
  if (request instanceof DecisionsRequestError) {
    ctx.dump?.error('gateway');
    return finalizeGatewayResponse(ctx, invalidRequest(c, request.message, request.param));
  }

  ctx.dump?.requestedModel(request.model);
  const response = await passthroughServe({
    c,
    ctx,
    sourceApi: '/decisions',
    operation: 'decision',
    model: request.model,
    kind: 'decision',
    modelServesEndpoint: model => model.endpoints.systemOne !== undefined,
    call: (provider, model, opts) => provider.instance.callSystemOne(model, request.systemOne, ctx.abortSignal, opts),
    response: { format: 'strategy', respond: respondDecisions(request.questions) },
  });
  return finalizeGatewayResponse(ctx, response);
};
