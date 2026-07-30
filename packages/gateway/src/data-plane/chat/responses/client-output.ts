import { wrapResponsesAffinityEgress } from './affinity/egress.ts';
import { wrapResponsesEnvelopeCompletion } from './envelope.ts';
import { wrapResponsesClientOutput } from './items/output.ts';
import { createResponsesResponseId } from './response-id.ts';
import type { GatewayCtx } from '../../shared/gateway-ctx.ts';
import { affinityEgressOptions } from '../shared/affinity/index.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { CanonicalResponsesPayload, ClientResponsesStreamEvent, ResponsesStreamEvent } from '@floway-dev/protocols/responses';

// Affinity wraps routing metadata first. The client-output boundary then stores
// each complete emitted item under its exact ID and applies one generated
// response ID to the downstream stream and snapshot. Envelope completion runs
// outermost, so it sees the ID the boundary applied and is the last thing that
// touches a response envelope before serialization.
export const wrapNativeResponsesClientOutput = (
  frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>,
  ctx: GatewayCtx,
  request: CanonicalResponsesPayload,
): AsyncIterable<ProtocolFrame<ClientResponsesStreamEvent>> => {
  if (!('affinity' in ctx) || !('store' in ctx)) throw new Error('Responses output reached the client-facing boundary without chat context');
  const chatCtx = ctx as ChatGatewayCtx;
  const withAffinity = wrapResponsesAffinityEgress(frames, affinityEgressOptions(ctx));
  const stored = wrapResponsesClientOutput(withAffinity, {
    store: chatCtx.store,
    responseId: createResponsesResponseId(),
  });
  return wrapResponsesEnvelopeCompletion(stored, {
    request,
    createdAt: Math.floor(ctx.requestStartedAt / 1000),
    stored: chatCtx.store.writesState,
  });
};
