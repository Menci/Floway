import { wrapResponsesAffinityEgress } from './affinity/egress.ts';
import { responsesItemIdentity } from './affinity/ingress.ts';
import { wrapResponsesClientOutput } from './items/output.ts';
import { createResponsesResponseId } from './response-id.ts';
import type { ChatGatewayCtx, GatewayCtx } from '../shared/gateway-ctx.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesStreamEvent } from '@floway-dev/protocols/responses';

// Affinity wraps routing metadata first. The client-output membrane then stores
// each complete client-facing projection under its producer-owned item id and
// owns the response envelope id shared by the downstream stream and snapshot.
export const wrapNativeResponsesClientOutput = (
  frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>,
  ctx: GatewayCtx,
): AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> => {
  if (!('affinity' in ctx) || !('store' in ctx)) throw new Error('Responses output reached the native client membrane without chat context');
  const chatCtx = ctx as ChatGatewayCtx;
  const withAffinity = wrapResponsesAffinityEgress(frames, {
    codec: chatCtx.affinity.codec,
    affinity: chatCtx.affinity.selectedTarget(),
  });
  return wrapResponsesClientOutput(withAffinity, {
    store: chatCtx.store,
    responseId: createResponsesResponseId(),
    producerIdentity: async item => await responsesItemIdentity(item, chatCtx.affinity.codec),
  });
};
