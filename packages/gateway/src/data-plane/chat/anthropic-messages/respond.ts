import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';

import { wrapAnthropicMessagesAffinityEgress } from './affinity/egress.ts';
import type { GatewayCtx } from '../../shared/gateway-ctx.ts';
import { type StreamCompletion, writeSSEFrames } from '../../shared/sse.ts';
import { recordFailedRequest } from '../../shared/telemetry/performance.ts';
import { settle } from '../../shared/telemetry/settle.ts';
import { tokenUsageFromBillableUsage } from '../../shared/telemetry/usage.ts';
import { forwardUpstreamHeaders, mergeForwardedUpstreamHeaders } from '../../shared/upstream-response.ts';
import { affinityEgressOptions } from '../shared/affinity/index.ts';
import { SourceStreamState, eventResultMetadata, plainResultToResponse } from '../shared/respond.ts';
import { anthropicMessagesProtocolFrameToSSEFrame, ANTHROPIC_MESSAGES_MISSING_TERMINAL_MESSAGE, collectAnthropicMessagesProtocolEventsToResult } from '@floway-dev/protocols/anthropic-messages';
import type { AnthropicMessagesStreamEvent } from '@floway-dev/protocols/anthropic-messages';
import { eventFrame, type ProtocolFrame, sseFrame } from '@floway-dev/protocols/common';
import { type ExecuteResult, type PlainResult, type InternalDebugError, toInternalDebugError } from '@floway-dev/provider';
import { apiErrorToResponse } from '@floway-dev/provider';

// Renders an upstream Anthropic Messages result into the client HTTP/SSE response. An
// error-typed result is a pre-stream failure and always answers as HTTP; an
// events result drains to one JSON body (non-streaming) or is proxied frame by
// frame (streaming).
export const respondAnthropicMessages = async (
  c: Context,
  result: ExecuteResult<ProtocolFrame<AnthropicMessagesStreamEvent>> | PlainResult,
  wantsStream: boolean,
  ctx: GatewayCtx,
): Promise<Response> => {
  if (result.type === 'api-error') {
    recordFailedRequest(ctx, result.performance);
    ctx.dump?.error(result.source, result.upstreamId);
    return apiErrorToResponse(result);
  }

  if (result.type === 'internal-error') {
    recordFailedRequest(ctx, result.performance);
    ctx.dump?.failed(result.error.message);
    return internalAnthropicMessagesErrorResponse(result.status, result.error);
  }

  if (result.type === 'plain') {
    if (result.status >= 400) {
      ctx.dump?.error(result.upstreamId !== undefined ? 'upstream' : 'gateway', result.upstreamId);
    }
    return plainResultToResponse(result);
  }

  const state = new SourceStreamState();
  const observed = observeAnthropicMessagesFrames(result.events, state, ctx);
  const frames = wrapAnthropicMessagesAffinityEgress(observed, affinityEgressOptions(ctx));

  if (!wantsStream) {
    try {
      const response = await collectAnthropicMessagesProtocolEventsToResult(frames);
      const metadata = await eventResultMetadata(result);
      const usage = tokenUsageFromBillableUsage(metadata.billableUsage);
      ctx.dump?.success(metadata.modelIdentity, usage);
      settle(ctx, metadata.performance, metadata.modelIdentity, usage, state.failed);
      return Response.json(response, { headers: mergeForwardedUpstreamHeaders(undefined, result.headers) });
    } catch (error) {
      recordFailedRequest(ctx, result.performance);
      ctx.dump?.failed(error);
      return internalAnthropicMessagesErrorResponse(502, toInternalDebugError(error));
    }
  }

  forwardUpstreamHeaders(c, result.headers);
  return streamSSE(c, async stream => {
    let completion: StreamCompletion = 'error';
    try {
      completion = await writeSSEFrames(stream, anthropicMessagesSseFrames(frames, state, ctx), {
        keepAlive: { frame: sseFrame(JSON.stringify({ type: 'ping' }), 'ping') },
        ...(ctx.downstreamAbortController !== undefined ? { downstreamAbortController: ctx.downstreamAbortController } : {}),
      });
    } finally {
      const metadata = await eventResultMetadata(result);
      const failed = state.failedAfter(completion);
      if (failed) {
        ctx.dump?.failed(`messages stream failed (completion=${completion}, source-failed=${state.failed})`);
      } else {
        ctx.dump?.success(metadata.modelIdentity, tokenUsageFromBillableUsage(metadata.billableUsage));
      }
      settle(ctx, metadata.performance, metadata.modelIdentity, tokenUsageFromBillableUsage(metadata.billableUsage), failed);
    }
  });
};

const internalAnthropicMessagesErrorPayload = (error: InternalDebugError) => ({
  type: 'error',
  error: {
    type: error.type,
    name: error.name,
    message: error.message,
    stack: error.stack,
    cause: error.cause,
    target_api: error.target_api,
  },
});

const internalAnthropicMessagesErrorResponse = (status: number, error: InternalDebugError): Response => Response.json(internalAnthropicMessagesErrorPayload(error), { status });

const isAnthropicMessagesTerminalFrame = (frame: ProtocolFrame<AnthropicMessagesStreamEvent>) => frame.type === 'event' && (frame.event.type === 'message_stop' || frame.event.type === 'error');

const observeAnthropicMessagesFrames = async function* (
  frames: AsyncIterable<ProtocolFrame<AnthropicMessagesStreamEvent>>,
  state: SourceStreamState,
  ctx: GatewayCtx,
) {
  for await (const frame of frames) {
    ctx.dump?.frame(frame);
    const failed = frame.type === 'event' && frame.event.type === 'error';
    if (failed) state.failed = true;
    if (isAnthropicMessagesTerminalFrame(frame) && !failed) state.completed = true;
    yield frame;
    if (isAnthropicMessagesTerminalFrame(frame)) return;
  }
  throw new Error(ANTHROPIC_MESSAGES_MISSING_TERMINAL_MESSAGE);
};

const anthropicMessagesSseFrames = async function* (frames: AsyncIterable<ProtocolFrame<AnthropicMessagesStreamEvent>>, state: SourceStreamState, ctx: GatewayCtx) {
  try {
    for await (const frame of frames) {
      const sse = anthropicMessagesProtocolFrameToSSEFrame(frame);
      if (sse) yield sse;
    }
  } catch (error) {
    state.failed = true;
    const event = internalAnthropicMessagesErrorPayload(toInternalDebugError(error)) as unknown as AnthropicMessagesStreamEvent;
    ctx.dump?.frame(eventFrame(event));
    yield sseFrame(JSON.stringify(event), 'error');
  }
};
