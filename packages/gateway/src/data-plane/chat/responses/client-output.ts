import { wrapResponsesAffinityEgress } from './affinity/egress.ts';
import { createResponsesResponseId } from './items/format.ts';
import { wrapResponsesClientOutput } from './items/output.ts';
import type { ChatGatewayCtx, GatewayCtx } from '../shared/gateway-ctx.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesStreamEvent } from '@floway-dev/protocols/responses';

// Affinity wraps only routing metadata. The client-output membrane separately
// replaces wire item ids and records their native Responses origin so the item
// store can restore those ids after a later request has selected its candidate.
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
  });
};
