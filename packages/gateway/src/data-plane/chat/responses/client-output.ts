import { wrapResponsesAffinityEgress } from './affinity/egress.ts';
import { wrapResponsesEnvelopeCompletion } from './envelope.ts';
import { wrapResponsesClientOutput } from './items/output.ts';
import { createResponsesResponseId } from './response-id.ts';
import type { GatewayCtx } from '../../shared/gateway-ctx.ts';
import { affinityEgressOptions } from '../shared/affinity/index.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { CanonicalResponsesPayload, ClientResponsesStreamEvent, ResponsesStreamEvent } from '@floway-dev/protocols/responses';

// Affinity wraps routing metadata first; the client-output boundary then stores
// each complete emitted item under its exact ID and applies one generated
// response ID to the downstream stream and snapshot. Every native Responses
// turn goes through this, whichever resource it answers with.
export const wrapResponsesStatefulOutput = (
  frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>,
  ctx: GatewayCtx,
): AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> => {
  if (!('affinity' in ctx) || !('store' in ctx)) throw new Error('Responses output reached the client-facing boundary without chat context');
  const chatCtx = ctx as ChatGatewayCtx;
  const withAffinity = wrapResponsesAffinityEgress(frames, affinityEgressOptions(ctx));
  return wrapResponsesClientOutput(withAffinity, {
    store: chatCtx.store,
    responseId: createResponsesResponseId(),
  });
};

// The generate path's egress: response-resource completion runs outermost, so
// it sees the ID the stateful boundary applied and is the last thing that
// touches an envelope before serialization. `/responses/compact` answers with
// `CompactResource` instead and completes its own five keys, so it stops at the
// stateful half.
export const wrapResponsesClientEgress = (
  frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>,
  ctx: GatewayCtx,
  request: CanonicalResponsesPayload,
): AsyncIterable<ProtocolFrame<ClientResponsesStreamEvent>> => {
  const stored = wrapResponsesStatefulOutput(frames, ctx);
  return wrapResponsesEnvelopeCompletion(stored, {
    request,
    createdAt: responsesCreatedAt(ctx),
    stored: (ctx as ChatGatewayCtx).store.writesState,
  });
};

// Unix seconds, from the gateway's own request-start instant.
export const responsesCreatedAt = (ctx: GatewayCtx): number => Math.floor(ctx.requestStartedAt / 1000);
