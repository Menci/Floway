import { wrapOpenAIResponsesAffinityEgress } from './affinity/egress.ts';
import { wrapOpenAIResponsesClientOutput } from './items/output.ts';
import { createOpenAIResponsesResponseId } from './response-id.ts';
import { wrapResponseResourceCompletion } from './response-resource.ts';
import type { GatewayCtx } from '../../shared/gateway-ctx.ts';
import type { ChatPipelineServices } from '../pipeline/index.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { CanonicalOpenAIResponsesPayload, ClientOpenAIResponsesStreamEvent, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

// Unix seconds, from the gateway's own request-start instant, so both resources
// date a turn the same way.
export const openaiResponsesCreatedAt = (ctx: GatewayCtx): number => Math.floor(ctx.requestStartedAt / 1000);

// Providers resolve their upstream's terminal snapshot omissions before
// affinity wraps routing metadata. The client-output boundary stores each
// complete emitted item under its exact ID and applies one generated response
// ID to the downstream stream and snapshot. Every native OpenAI Responses turn goes
// through this half, whichever resource it answers with.
export const wrapOpenAIResponsesStatefulOutput = (
  frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>>,
  ctx: ChatGatewayCtx | ChatPipelineServices,
  responseId = createOpenAIResponsesResponseId(),
): AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>> => {
  const services = 'chatCtx' in ctx ? ctx : undefined;
  const chatCtx = services?.chatCtx ?? ctx as ChatGatewayCtx;
  const withAffinity = wrapOpenAIResponsesAffinityEgress(frames, services?.affinity.egressOptions() ?? {
    codec: chatCtx.affinity.codec,
    affinity: chatCtx.affinity.selectedTarget(),
  });
  return wrapOpenAIResponsesClientOutput(withAffinity, {
    store: chatCtx.store,
    responseId,
  });
};

// The generate path's egress: the stateful half plus the response resource's
// completion. `/responses/compact` answers with `CompactResource`, so it stops
// at the stateful half and completes that resource itself.
export const wrapOpenAIResponsesClientEgress = (
  frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>>,
  ctx: GatewayCtx | ChatPipelineServices,
  request: CanonicalOpenAIResponsesPayload,
  responseId?: string,
): AsyncIterable<ProtocolFrame<ClientOpenAIResponsesStreamEvent>> => {
  const chatCtx = 'chatCtx' in ctx ? ctx.chatCtx : ctx as ChatGatewayCtx;
  if (!('affinity' in chatCtx) || !('store' in chatCtx)) throw new Error('OpenAI Responses output requires chat context');
  return wrapResponseResourceCompletion(wrapOpenAIResponsesStatefulOutput(frames, 'chatCtx' in ctx ? ctx : chatCtx, responseId), {
    request,
    createdAt: openaiResponsesCreatedAt(chatCtx),
    stored: chatCtx.store.writesState,
  });
};
