// POST /v1/completions and /completions — OpenAI text completions
// passthrough. The endpoint sits outside the chat source/target executor:
// no protocol translation, no interceptor chain, no cross-protocol
// traversal. The request body is forwarded to the chosen provider's
// /completions verbatim; the response (single-shot JSON or streaming SSE
// depending on the client's `stream` flag) flows back through the shared
// passthroughServe scaffold.

import type { Context } from 'hono';

import { tokenUsageFromCompletionsUsage } from './usage.ts';
import type { TokenUsage } from '../../repo/types.ts';
import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import { createGatewayCtxFromHono, finalizeGatewayResponse } from '../shared/gateway-ctx.ts';
import { prepareJsonModelRequest } from '../shared/passthrough-request.ts';
import { passthroughApiError, passthroughServe } from '../shared/passthrough-serve.ts';
import { readRequestBody, takeRequestBody } from '../shared/request-body.ts';
import { isOpenAIUsageOnlyEventShape, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { ProviderModel } from '@floway-dev/provider';

export const completions = async (c: Context): Promise<Response> => {
  const requestBody = await readRequestBody(c);
  const request = prepareJsonModelRequest(requestBody.bytes, 'Completions');
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
    return finalizeGatewayResponse(ctx, passthroughApiError(c, request.message, 400));
  }

  ctx.dump?.requestedModel(request.model);
  const streamOptions = request.body.stream_options as { include_usage?: unknown } | null | undefined;
  const clientWantsUsageChunk = streamOptions?.include_usage === true;
  // Strip the inbound model; the provider re-stamps the upstream-resolved
  // model id. For streaming requests we force `stream_options.include_usage`
  // on so billing always sees the usage chunk — sibling keys on
  // stream_options (if any) ride through unchanged.
  const { model: _model, ...upstreamBodyBase } = request.body;
  const upstreamBody = wantsStream
    ? { ...upstreamBodyBase, stream_options: { ...(streamOptions ?? {}), include_usage: true } }
    : upstreamBodyBase;

  // Streaming closure: track the usage block (only on the usage-only
  // chunk per OpenAI spec) and service_tier independently — service_tier
  // can ride on any event root, so settling them together at the end
  // lets the tier override land regardless of which chunk carried it.
  let streamingUsageBlock: unknown = null;
  let streamingServiceTier: string | null | undefined;
  // The scaffold picks the upstream after these closures are built, and this
  // endpoint has no interceptor chain to normalize usage on the way in, so
  // the serving model is staked here for the billing read to consult.
  let serving: { model: ProviderModel; upstreamId: string } | undefined;
  const declaredExclusive = (): boolean => serving?.model.enabledFlags.has('usage-exclusive-cached-tokens') === true;
  const servingIdentity = (): string => serving === undefined ? 'unresolved upstream' : `${serving.upstreamId}/${serving.model.id}`;
  const transformFrame = (frame: ProtocolFrame<unknown>): ProtocolFrame<unknown> | null => {
    if (frame.type !== 'event') return frame;
    const eventRoot = frame.event as { service_tier?: string | null; usage?: unknown };
    if (eventRoot.service_tier !== undefined) streamingServiceTier = eventRoot.service_tier;
    if (!isOpenAIUsageOnlyEventShape(frame.event)) return frame;
    streamingUsageBlock = eventRoot.usage;
    return clientWantsUsageChunk ? frame : null;
  };
  const settleUsage = (): TokenUsage | null =>
    streamingUsageBlock === null ? null : tokenUsageFromCompletionsUsage(streamingUsageBlock, streamingServiceTier, declaredExclusive(), servingIdentity());

  const response = await passthroughServe({
    c,
    ctx,
    sourceApi: '/completions',
    operation: 'text_completion',
    model: request.model,
    kind: 'chat',
    modelServesEndpoint: model => model.endpoints.completions !== undefined,
    call: (provider, model, opts) => {
      serving = { model, upstreamId: provider.upstreamId };
      return provider.instance.callCompletions(model, upstreamBody, ctx.abortSignal, opts);
    },
    response: wantsStream
      ? { format: 'sse', transformFrame, settleUsage }
      : {
          format: 'json',
          extractBilling: (body: unknown) => {
            if (!body || typeof body !== 'object') return null;
            const { usage, service_tier: tier } = body as { usage?: unknown; service_tier?: string | null };
            return tokenUsageFromCompletionsUsage(usage, tier, declaredExclusive(), servingIdentity());
          },
        },
  });
  return finalizeGatewayResponse(ctx, response);
};
