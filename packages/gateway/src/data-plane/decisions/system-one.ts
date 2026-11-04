// POST /v1/systemone — Microsoft System One decision scoring. The request is
// already in the upstream wire shape, so it is forwarded verbatim apart from
// the provider's model id, and the upstream response is relayed unchanged.
// https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-microsoft-decision

import type { Context } from 'hono';

import { tokenUsageFromSystemOneBody } from './usage.ts';
import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import { createGatewayCtxFromHono, finalizeGatewayResponse } from '../shared/gateway-ctx.ts';
import { prepareJsonModelRequest } from '../shared/passthrough-request.ts';
import { passthroughApiError, passthroughServe } from '../shared/passthrough-serve.ts';
import { readRequestBody, takeRequestBody } from '../shared/request-body.ts';

export const systemOne = async (c: Context): Promise<Response> => {
  const requestBody = await readRequestBody(c);
  const request = prepareJsonModelRequest(requestBody.bytes, 'System One');
  const ctx = createGatewayCtxFromHono(c, { wantsStream: false, requestBody: takeRequestBody(requestBody), backgroundScheduler: backgroundSchedulerFromContext(c) });
  if (request.type === 'invalid') {
    ctx.dump?.error('gateway');
    return finalizeGatewayResponse(ctx, passthroughApiError(c, request.message, 400));
  }

  ctx.dump?.requestedModel(request.model);
  const { model: _model, ...body } = request.body;
  const response = await passthroughServe({
    c,
    ctx,
    sourceApi: '/systemone',
    operation: 'decision',
    model: request.model,
    kind: 'decision',
    modelServesEndpoint: model => model.endpoints.systemOne !== undefined,
    call: (provider, model, opts) => provider.instance.callSystemOne(model, body, ctx.abortSignal, opts),
    response: { format: 'json', extractBilling: tokenUsageFromSystemOneBody },
  });
  return finalizeGatewayResponse(ctx, response);
};
