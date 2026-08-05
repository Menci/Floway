import { wrapResponsesAffinityEgress } from './affinity/egress.ts';
import { wrapResponsesClientOutput, wrapResponsesObservedOutput } from './items/output.ts';
import { createResponsesResponseId } from './response-id.ts';
import { wrapResponseResourceCompletion } from './response-resource.ts';
import type { GatewayCtx } from '../../shared/gateway-ctx.ts';
import { affinityEgressOptions } from '../shared/affinity/index.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { CanonicalResponsesPayload, ClientResponsesStreamEvent, ResponsesStreamEvent } from '@floway-dev/protocols/responses';

// Unix seconds, from the gateway's own request-start instant, so both resources
// date a turn the same way.
export const responsesCreatedAt = (ctx: GatewayCtx): number => Math.floor(ctx.requestStartedAt / 1000);

// The item lifecycle first resolves any partial terminal restatement. Affinity
// then wraps routing metadata, and the client-output boundary stores each
// complete emitted item under its exact ID and applies one generated response
// ID to the downstream stream and snapshot. Every native Responses turn goes
// through this half, whichever resource it answers with.
export const wrapResponsesStatefulOutput = (
  frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>,
  ctx: ChatGatewayCtx,
): AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> => {
  const withObservedOutput = wrapResponsesObservedOutput(frames);
  const withAffinity = wrapResponsesAffinityEgress(withObservedOutput, affinityEgressOptions(ctx));
  return wrapResponsesClientOutput(withAffinity, {
    store: ctx.store,
    responseId: createResponsesResponseId(),
  });
};

// The generate path's egress: the stateful half plus the response resource's
// completion. `/responses/compact` answers with `CompactResource`, so it stops
// at the stateful half and completes that resource itself.
export const wrapResponsesClientEgress = (
  frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>,
  ctx: GatewayCtx,
  request: CanonicalResponsesPayload,
): AsyncIterable<ProtocolFrame<ClientResponsesStreamEvent>> => {
  if (!('affinity' in ctx) || !('store' in ctx)) throw new Error('Responses output requires chat context');
  const chatCtx = ctx as ChatGatewayCtx;
  return wrapResponseResourceCompletion(wrapResponsesStatefulOutput(frames, chatCtx), {
    request,
    createdAt: responsesCreatedAt(ctx),
    stored: chatCtx.store.writesState,
  });
};
