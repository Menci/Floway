import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';

import { wrapChatCompletionsAffinityEgress } from './affinity/egress.ts';
import type { GatewayCtx } from '../../shared/gateway-ctx.ts';
import { type StreamCompletion, writeSSEFrames } from '../../shared/sse.ts';
import { recordFailedRequest } from '../../shared/telemetry/performance.ts';
import { settle } from '../../shared/telemetry/settle.ts';
import { tokenUsageFromBillableUsage } from '../../shared/telemetry/usage.ts';
import { forwardUpstreamHeaders, mergeForwardedUpstreamHeaders } from '../../shared/upstream-response.ts';
import { affinityEgressOptions } from '../shared/affinity/index.ts';
import { SourceStreamState, eventResultMetadata, plainResultToResponse } from '../shared/respond.ts';
import type { ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import { chatCompletionsProtocolFrameToSSEFrame, CHAT_COMPLETIONS_MISSING_TERMINAL_MESSAGE, collectChatCompletionsProtocolEventsToResult, chatCompletionsErrorPayloadMessage } from '@floway-dev/protocols/chat-completions';
import { eventFrame, type ProtocolFrame, sseCommentFrame, sseFrame } from '@floway-dev/protocols/common';
import { type ExecuteResult, type PlainResult, type InternalDebugError, toInternalDebugError } from '@floway-dev/provider';
import { apiErrorToResponse } from '@floway-dev/provider';

export const respondChatCompletions = async (
  c: Context,
  result: ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>> | PlainResult,
  wantsStream: boolean,
  includeUsageChunk: boolean,
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
    return internalChatCompletionsErrorResponse(result.status, result.error);
  }

  if (result.type === 'plain') {
    if (result.status >= 400) {
      ctx.dump?.error(result.upstreamId !== undefined ? 'upstream' : 'gateway', result.upstreamId);
    }
    return plainResultToResponse(result);
  }

  const state = new SourceStreamState();
  const observed = observeChatCompletionsFrames(result.events, state, ctx);
  const frames = wrapChatCompletionsAffinityEgress(observed, affinityEgressOptions(ctx));

  if (!wantsStream) {
    try {
      const response = await collectChatCompletionsProtocolEventsToResult(frames);
      const metadata = await eventResultMetadata(result);
      const usage = tokenUsageFromBillableUsage(metadata.billableUsage);
      ctx.dump?.success(metadata.modelIdentity, usage);
      settle(ctx, metadata.performance, metadata.modelIdentity, usage, state.failed);
      return Response.json(response, { headers: mergeForwardedUpstreamHeaders(undefined, result.headers) });
    } catch (error) {
      recordFailedRequest(ctx, result.performance);
      ctx.dump?.failed(error);
      return internalChatCompletionsErrorResponse(502, toInternalDebugError(error));
    }
  }

  forwardUpstreamHeaders(c, result.headers);
  return streamSSE(c, async stream => {
    let completion: StreamCompletion = 'error';
    try {
      completion = await writeSSEFrames(stream, chatCompletionsSseFrames(frames, includeUsageChunk, state, ctx), {
        keepAlive: { frame: sseCommentFrame('keepalive') },
        ...(ctx.downstreamAbortController !== undefined ? { downstreamAbortController: ctx.downstreamAbortController } : {}),
      });
    } finally {
      const metadata = await eventResultMetadata(result);
      const failed = state.failedAfter(completion);
      if (failed) {
        ctx.dump?.failed(`chat-completions stream failed (completion=${completion}, source-failed=${state.failed})`);
      } else {
        ctx.dump?.success(metadata.modelIdentity, tokenUsageFromBillableUsage(metadata.billableUsage));
      }
      settle(ctx, metadata.performance, metadata.modelIdentity, tokenUsageFromBillableUsage(metadata.billableUsage), failed);
    }
  });
};

// --- error rendering ---

const internalChatCompletionsErrorPayload = (error: InternalDebugError) => ({
  error: {
    type: error.type,
    name: error.name,
    message: error.message,
    stack: error.stack,
    cause: error.cause,
    target_api: error.target_api,
  },
});

const internalChatCompletionsErrorResponse = (status: number, error: InternalDebugError): Response => Response.json(internalChatCompletionsErrorPayload(error), { status });

// --- frame observation ---

const isChatCompletionsFailureFrame = (frame: ProtocolFrame<ChatCompletionsStreamEvent>) => frame.type === 'event' && chatCompletionsErrorPayloadMessage(frame.event) !== null;

const isChatCompletionsTerminalFrame = (frame: ProtocolFrame<ChatCompletionsStreamEvent>) => frame.type === 'done' || isChatCompletionsFailureFrame(frame);

const observeChatCompletionsFrames = async function* (frames: AsyncIterable<ProtocolFrame<ChatCompletionsStreamEvent>>, state: SourceStreamState, ctx: GatewayCtx) {
  for await (const frame of frames) {
    ctx.dump?.frame(frame);
    const failed = isChatCompletionsFailureFrame(frame);
    if (failed) state.failed = true;
    if (isChatCompletionsTerminalFrame(frame) && !failed) state.completed = true;
    yield frame;
    if (isChatCompletionsTerminalFrame(frame)) return;
  }
  throw new Error(CHAT_COMPLETIONS_MISSING_TERMINAL_MESSAGE);
};

const chatCompletionsSseFrames = async function* (frames: AsyncIterable<ProtocolFrame<ChatCompletionsStreamEvent>>, includeUsageChunk: boolean, state: SourceStreamState, ctx: GatewayCtx) {
  try {
    for await (const frame of frames) {
      const sse = chatCompletionsProtocolFrameToSSEFrame(frame, { includeUsageChunk });
      if (sse) yield sse;
    }
  } catch (error) {
    state.failed = true;
    const event = internalChatCompletionsErrorPayload(toInternalDebugError(error)) as unknown as ChatCompletionsStreamEvent;
    ctx.dump?.frame(eventFrame(event));
    yield sseFrame(JSON.stringify(event), 'error');
  }
};
