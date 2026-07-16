import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';

import { wrapChatCompletionsAffinityEgress } from './affinity/egress.ts';
import { tokenUsageFromChatCompletionsUsage } from './usage.ts';
import { recordFailedRequest } from '../../shared/telemetry/performance.ts';
import { settle } from '../../shared/telemetry/settle.ts';
import { affinityEgressOptions } from '../shared/affinity/index.ts';
import type { GatewayCtx } from '../shared/gateway-ctx.ts';
import { SourceStreamState, eventResultMetadata, forwardUpstreamHeaders, mergeForwardedUpstreamHeaders, plainResultToResponse } from '../shared/respond.ts';
import { type StreamCompletion, writeSSEFrames } from '../shared/stream/sse.ts';
import type { ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import { chatCompletionsProtocolFrameToSSEFrame, CHAT_COMPLETIONS_MISSING_TERMINAL_MESSAGE, collectChatCompletionsProtocolEventsToResult, chatCompletionsErrorPayloadMessage } from '@floway-dev/protocols/chat-completions';
import { type ProtocolFrame, sseCommentFrame, sseFrame } from '@floway-dev/protocols/common';
import { type ExecuteResult, type PlainResult, type InternalDebugError, toInternalDebugError } from '@floway-dev/provider';
import { apiErrorToResponse } from '@floway-dev/provider';

export const respondChatCompletions = async (
  c: Context,
  result: ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>> | PlainResult,
  wantsStream: boolean,
  includeUsageChunk: boolean,
  ctx: GatewayCtx,
): Promise<{ success: boolean; response: Response }> => {
  if (result.type === 'api-error') {
    recordFailedRequest(ctx, result.performance);
    ctx.dump?.error(result.source, result.upstream);
    return { success: false, response: apiErrorToResponse(result) };
  }

  if (result.type === 'internal-error') {
    recordFailedRequest(ctx, result.performance);
    ctx.dump?.failed(result.error.message);
    return { success: false, response: internalChatCompletionsErrorResponse(result.status, result.error) };
  }

  if (result.type === 'plain') {
    if (result.status >= 400) {
      ctx.dump?.error(result.upstream !== undefined ? 'upstream' : 'gateway', result.upstream);
    }
    return { success: true, response: plainResultToResponse(result) };
  }

  const state = new SourceStreamState();
  const observed = observeChatCompletionsFrames(result.events, state, wantsStream, ctx);
  const frames = wrapChatCompletionsAffinityEgress(observed, affinityEgressOptions(ctx));

  if (!wantsStream) {
    try {
      const response = await collectChatCompletionsProtocolEventsToResult(frames);
      const metadata = await eventResultMetadata(result);
      const usage = response.usage ? tokenUsageFromChatCompletionsUsage(response.usage, response.service_tier) : null;
      ctx.dump?.success(metadata.modelIdentity, usage);
      settle(ctx, metadata.performance, metadata.modelIdentity, usage, state.failed);
      return { success: true, response: Response.json(response, { headers: mergeForwardedUpstreamHeaders(undefined, result.headers) }) };
    } catch (error) {
      recordFailedRequest(ctx, result.performance);
      ctx.dump?.failed(error);
      return { success: false, response: internalChatCompletionsErrorResponse(502, toInternalDebugError(error)) };
    }
  }

  forwardUpstreamHeaders(c, result.headers);
  const response = streamSSE(c, async stream => {
    let completion: StreamCompletion = 'error';
    try {
      completion = await writeSSEFrames(stream, chatCompletionsSseFrames(frames, includeUsageChunk, state), {
        keepAlive: { frame: sseCommentFrame('keepalive') },
        ...(ctx.downstreamAbortController !== undefined ? { downstreamAbortController: ctx.downstreamAbortController } : {}),
      });
    } finally {
      const metadata = await eventResultMetadata(result);
      const failed = state.failedAfter(completion);
      if (failed) {
        ctx.dump?.failed(`chat-completions stream failed (completion=${completion}, source-failed=${state.failed})`);
      } else {
        ctx.dump?.success(metadata.modelIdentity, state.usage);
      }
      settle(ctx, metadata.performance, metadata.modelIdentity, state.usage, failed);
    }
  });

  return { success: true, response };
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

const observeChatCompletionsFrames = async function* (frames: AsyncIterable<ProtocolFrame<ChatCompletionsStreamEvent>>, state: SourceStreamState, observeUsage: boolean, ctx: GatewayCtx) {
  for await (const frame of frames) {
    ctx.dump?.frame(frame);
    const failed = isChatCompletionsFailureFrame(frame);
    if (failed) state.failed = true;
    if (observeUsage) {
      state.rememberUsage(frame.type === 'event' && Array.isArray(frame.event.choices) && frame.event.choices.length === 0 && frame.event.usage ? tokenUsageFromChatCompletionsUsage(frame.event.usage, frame.event.service_tier) : null);
    }
    if (isChatCompletionsTerminalFrame(frame) && !failed) state.completed = true;
    yield frame;
    if (isChatCompletionsTerminalFrame(frame)) return;
  }
  throw new Error(CHAT_COMPLETIONS_MISSING_TERMINAL_MESSAGE);
};

const chatCompletionsSseFrames = async function* (frames: AsyncIterable<ProtocolFrame<ChatCompletionsStreamEvent>>, includeUsageChunk: boolean, state: SourceStreamState) {
  try {
    for await (const frame of frames) {
      const sse = chatCompletionsProtocolFrameToSSEFrame(frame, { includeUsageChunk });
      if (sse) yield sse;
    }
  } catch (error) {
    state.failed = true;
    yield sseFrame(JSON.stringify(internalChatCompletionsErrorPayload(toInternalDebugError(error))), 'error');
  }
};
