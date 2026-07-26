import { wrapResponsesAffinityEgress } from './affinity/egress.ts';
import { wrapResponsesClientOutput } from './items/output.ts';
import { createResponsesResponseId } from './response-id.ts';
import type { GatewayCtx } from '../../shared/gateway-ctx.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesStreamEvent } from '@floway-dev/protocols/responses';

// Affinity wraps routing metadata first. The client-output boundary then stores
// each complete emitted item under its exact ID and applies one generated
// response ID to the downstream stream and snapshot.
export const wrapNativeResponsesClientOutput = (
  frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>,
  ctx: GatewayCtx,
): AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> => {
  if (!('affinity' in ctx) || !('store' in ctx)) throw new Error('Responses output reached the client-facing boundary without chat context');
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
