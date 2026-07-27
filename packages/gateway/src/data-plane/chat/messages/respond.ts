import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';

import { wrapMessagesAffinityEgress } from './affinity/egress.ts';
import { createMessagesStreamUsageState, tokenUsageFromMessagesFrame, tokenUsageFromMessagesUsage, type MessagesStreamUsageState } from './usage.ts';
import type { GatewayCtx } from '../../shared/gateway-ctx.ts';
import { type StreamCompletion, writeSSEFrames } from '../../shared/sse.ts';
import { recordFailedRequest } from '../../shared/telemetry/performance.ts';
import { settle } from '../../shared/telemetry/settle.ts';
import { forwardUpstreamHeaders, mergeForwardedUpstreamHeaders } from '../../shared/upstream-response.ts';
import { affinityEgressOptions } from '../shared/affinity/index.ts';
import { SourceStreamState, eventResultMetadata, plainResultToResponse } from '../shared/respond.ts';
import { type ProtocolFrame, sseFrame } from '@floway-dev/protocols/common';
import { messagesProtocolFrameToSSEFrame, MESSAGES_MISSING_TERMINAL_MESSAGE, collectMessagesProtocolEventsToResult } from '@floway-dev/protocols/messages';
import type { MessagesStreamEvent } from '@floway-dev/protocols/messages';
import { type ExecuteResult, type PlainResult, type InternalDebugError, toInternalDebugError } from '@floway-dev/provider';
import { apiErrorToResponse } from '@floway-dev/provider';

// Renders an upstream Messages result into the client HTTP/SSE response. An
// error-typed result is a pre-stream failure and always answers as HTTP; an
// events result drains to one JSON body (non-streaming) or is proxied frame by
// frame (streaming).
export const respondMessages = async (
  c: Context,
  result: ExecuteResult<ProtocolFrame<MessagesStreamEvent>> | PlainResult,
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
    return internalMessagesErrorResponse(result.status, result.error);
  }

  if (result.type === 'plain') {
    if (result.status >= 400) {
      ctx.dump?.error(result.upstreamId !== undefined ? 'upstream' : 'gateway', result.upstreamId);
    }
    return plainResultToResponse(result);
  }

  const state = new SourceStreamState();
  const usageState = createMessagesStreamUsageState();
  const observed = observeMessagesFrames(result.events, state, usageState, wantsStream, ctx);
  const frames = wrapMessagesAffinityEgress(observed, affinityEgressOptions(ctx));

  if (!wantsStream) {
    try {
      const response = await collectMessagesProtocolEventsToResult(frames);
      const metadata = await eventResultMetadata(result);
      const usage = tokenUsageFromMessagesUsage(response.usage);
      ctx.dump?.success(metadata.modelIdentity, usage);
      settle(ctx, metadata.performance, metadata.modelIdentity, usage, state.failed);
      return Response.json(response, { headers: mergeForwardedUpstreamHeaders(undefined, result.headers) });
    } catch (error) {
      recordFailedRequest(ctx, result.performance);
      ctx.dump?.failed(error);
      return internalMessagesErrorResponse(502, toInternalDebugError(error));
    }
  }

  forwardUpstreamHeaders(c, result.headers);
  return streamSSE(c, async stream => {
    let completion: StreamCompletion = 'error';
    try {
      completion = await writeSSEFrames(stream, messagesSseFrames(frames, state), {
        keepAlive: { frame: sseFrame(JSON.stringify({ type: 'ping' }), 'ping') },
        ...(ctx.downstreamAbortController !== undefined ? { downstreamAbortController: ctx.downstreamAbortController } : {}),
      });
    } finally {
      const metadata = await eventResultMetadata(result);
      const failed = state.failedAfter(completion);
      if (failed) {
        ctx.dump?.failed(`messages stream failed (completion=${completion}, source-failed=${state.failed})`);
      } else {
        ctx.dump?.success(metadata.modelIdentity, state.usage);
      }
      settle(ctx, metadata.performance, metadata.modelIdentity, state.usage, failed);
    }
  });
};

const internalMessagesErrorPayload = (error: InternalDebugError) => ({
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

const internalMessagesErrorResponse = (status: number, error: InternalDebugError): Response => Response.json(internalMessagesErrorPayload(error), { status });

const isMessagesTerminalFrame = (frame: ProtocolFrame<MessagesStreamEvent>) => frame.type === 'event' && (frame.event.type === 'message_stop' || frame.event.type === 'error');

const observeMessagesFrames = async function* (
  frames: AsyncIterable<ProtocolFrame<MessagesStreamEvent>>,
  state: SourceStreamState,
  usageState: MessagesStreamUsageState,
  observeUsage: boolean,
  ctx: GatewayCtx,
) {
  for await (const frame of frames) {
    ctx.dump?.frame(frame);
    const failed = frame.type === 'event' && frame.event.type === 'error';
    if (failed) state.failed = true;
    if (observeUsage) {
      state.rememberUsage(tokenUsageFromMessagesFrame(frame, usageState));
    }
    if (isMessagesTerminalFrame(frame) && !failed) state.completed = true;
    yield frame;
    if (isMessagesTerminalFrame(frame)) return;
  }
  throw new Error(MESSAGES_MISSING_TERMINAL_MESSAGE);
};

const messagesSseFrames = async function* (frames: AsyncIterable<ProtocolFrame<MessagesStreamEvent>>, state: SourceStreamState) {
  try {
    for await (const frame of frames) {
      const sse = messagesProtocolFrameToSSEFrame(frame);
      if (sse) yield sse;
    }
  } catch (error) {
    state.failed = true;
    yield sseFrame(JSON.stringify(internalMessagesErrorPayload(toInternalDebugError(error))), 'error');
  }
};
