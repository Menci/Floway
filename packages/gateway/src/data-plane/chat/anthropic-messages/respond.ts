import type { Context } from 'hono';

import { wrapAnthropicMessagesAffinityEgress } from './affinity/egress.ts';
import type { GatewayCtx } from '../../shared/gateway-ctx.ts';
import { serializeSseFrame, serveSse } from '../../shared/sse.ts';
import { recordFailedRequest } from '../../shared/telemetry/performance.ts';
import { settle } from '../../shared/telemetry/settle.ts';
import { tokenUsageFromBillableUsage } from '../../shared/telemetry/usage.ts';
import { forwardBufferedUpstreamResponse } from '../../shared/upstream-response.ts';
import { affinityEgressOptions } from '../shared/affinity/index.ts';
import { eventResultMetadata, jsonResponseInit, observeChatFrames, settleChatSse } from '../shared/respond.ts';
import { anthropicMessagesProtocolFrameToSSEFrame, ANTHROPIC_MESSAGES_MISSING_TERMINAL_MESSAGE, collectAnthropicMessagesProtocolEventsToResult } from '@floway-dev/protocols/anthropic-messages';
import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import { eventFrame, type ProtocolFrame, sseFrame } from '@floway-dev/protocols/common';
import { type ExecuteResult, type PlainResult, type InternalDebugError, internalDebugErrorFields, toInternalDebugError } from '@floway-dev/provider';

// Renders an upstream Anthropic Messages result into the client HTTP/SSE response. An
// error-typed result is a pre-stream failure and always answers as HTTP; an
// events result drains to one JSON body (non-streaming) or is proxied frame by
// frame (streaming).
export const respondAnthropicMessages = async (
  c: Context,
  result: ExecuteResult<ProtocolFrame<AnthropicMessagesStreamEventEx>> | PlainResult,
  wantsStream: boolean,
  ctx: GatewayCtx,
): Promise<Response> => {
  if (result.type === 'api-error') {
    recordFailedRequest(ctx, result.performance);
    ctx.dump?.error(result.source, result.upstreamId);
    return forwardBufferedUpstreamResponse(result);
  }

  if (result.type === 'internal-error') {
    recordFailedRequest(ctx, result.performance);
    ctx.dump?.failed(result.error.message);
    return internalAnthropicMessagesErrorResponse(result.http, result.error);
  }

  if (result.type === 'plain') {
    if (result.http.status >= 400) {
      ctx.dump?.error(result.upstreamId !== undefined ? 'upstream' : 'gateway', result.upstreamId);
    }
    return forwardBufferedUpstreamResponse(result);
  }

  const frames = wrapAnthropicMessagesAffinityEgress(observeChatFrames(result.events, ctx), affinityEgressOptions(ctx));

  if (!wantsStream) {
    try {
      const response = await collectAnthropicMessagesProtocolEventsToResult(frames);
      const metadata = await eventResultMetadata(result);
      const usage = tokenUsageFromBillableUsage(metadata.billableUsage);
      ctx.dump?.success(metadata.modelIdentity, usage);
      settle(ctx, metadata.performance, metadata.modelIdentity, usage, false);
      return Response.json(response, jsonResponseInit(result.http));
    } catch (error) {
      recordFailedRequest(ctx, result.performance);
      ctx.dump?.failed(error);
      return internalAnthropicMessagesErrorResponse({ status: 502 }, toInternalDebugError(error));
    }
  }

  return serveSse(c, {
    http: result.http,
    events: frames,
    keepAlive: { frame: sseFrame(JSON.stringify({ type: 'ping' }), 'ping') },
    downstreamAbortController: ctx.downstreamAbortController,
    protocol: {
      encode: frame => {
        const output = anthropicMessagesProtocolFrameToSSEFrame(frame);
        const wire = output === null ? null : serializeSseFrame(output);
        if (frame.type === 'event') {
          if (frame.event.type === 'message_stop') return { wire, end: { type: 'completed' } };
          if (frame.event.type === 'error') return { wire, end: { type: 'protocol-error' } };
        }
        return { wire };
      },
      eof: () => ({ type: 'premature-eof', error: new Error(ANTHROPIC_MESSAGES_MISSING_TERMINAL_MESSAGE) }),
      failure: error => {
        // Anthropic's SSE error body uses its Messages API error types.
        // https://github.com/anthropics/anthropic-sdk-typescript/blob/3f13f60335f8bcf91a782785f4f16e4267c999ad/src/resources/shared.ts#L247-L255
        const payload = internalAnthropicMessagesErrorPayload(toInternalDebugError(error));
        const event = { ...payload, error: { ...payload.error, type: 'api_error' } };
        ctx.dump?.frame(eventFrame(event));
        return [serializeSseFrame(sseFrame(JSON.stringify(event), 'error'))];
      },
    },
    settle: outcome => settleChatSse(ctx, result, outcome),
  });
};

const internalAnthropicMessagesErrorPayload = (error: InternalDebugError) => ({
  type: 'error',
  error: {
    type: error.type,
    message: error.message,
    provider_specific_fields: internalDebugErrorFields(error),
  },
});

const internalAnthropicMessagesErrorResponse = (http: ResponseInit, error: InternalDebugError): Response => Response.json(internalAnthropicMessagesErrorPayload(error), http);
