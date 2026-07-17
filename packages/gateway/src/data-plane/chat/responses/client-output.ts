import { wrapResponsesAffinityEgress } from './affinity/egress.ts';
import { createResponsesResponseId } from './items/format.ts';
import { wrapResponsesClientOutput } from './items/output.ts';
import type { ChatGatewayCtx, GatewayCtx } from '../shared/gateway-ctx.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesStreamEvent } from '@floway-dev/protocols/responses';

// Affinity must observe upstream item ids before the client-output membrane
// replaces them. The state layer then persists exactly the wrapped,
// client-visible items under the same response id it emits downstream.
export const wrapNativeResponsesClientOutput = (
  frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>,
  ctx: GatewayCtx,
): AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> => {
  if (!('affinity' in ctx) || !('store' in ctx)) throw new Error('Responses output reached the native client membrane without chat context');
  const chatCtx = ctx as ChatGatewayCtx;
  if (chatCtx.store === undefined) throw new Error('Native Responses client output requires a state store');
  const withAffinity = wrapResponsesAffinityEgress(frames, {
    codec: chatCtx.affinity.codec,
    affinity: chatCtx.affinity.selectedTarget(),
  });
  return wrapResponsesClientOutput(withAffinity, {
    store: chatCtx.store,
    attemptState: chatCtx.responsesAttemptState,
    responseId: createResponsesResponseId(),
  });
};
