import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';

import { wrapOpenAIChatCompletionsAffinityEgress } from './affinity/egress.ts';
import type { GatewayCtx } from '../../shared/gateway-ctx.ts';
import { type StreamCompletion, writeSSEFrames } from '../../shared/sse.ts';
import { recordFailedRequest } from '../../shared/telemetry/performance.ts';
import { settle } from '../../shared/telemetry/settle.ts';
import { tokenUsageFromBillableUsage } from '../../shared/telemetry/usage.ts';
import { forwardUpstreamHeaders, mergeForwardedUpstreamHeaders } from '../../shared/upstream-response.ts';
import { affinityEgressOptions } from '../shared/affinity/index.ts';
import { SourceStreamState, eventResultMetadata, plainResultToResponse } from '../shared/respond.ts';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import { openaiChatCompletionsProtocolFrameToSSEFrame, OPENAI_CHAT_COMPLETIONS_MISSING_TERMINAL_MESSAGE, collectOpenAIChatCompletionsProtocolEventsToResult, openaiChatCompletionsErrorPayloadMessage } from '@floway-dev/protocols/openai-chat-completions';
import { eventFrame, type ProtocolFrame, sseCommentFrame, sseFrame } from '@floway-dev/protocols/common';
import { type ExecuteResult, type PlainResult, type InternalDebugError, toInternalDebugError } from '@floway-dev/provider';
import { apiErrorToResponse } from '@floway-dev/provider';

export const respondOpenAIChatCompletions = async (
  c: Context,
  result: ExecuteResult<ProtocolFrame<OpenAIChatCompletionsStreamEvent>> | PlainResult,
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
    return internalOpenAIChatCompletionsErrorResponse(result.status, result.error);
  }

  if (result.type === 'plain') {
    if (result.status >= 400) {
      ctx.dump?.error(result.upstreamId !== undefined ? 'upstream' : 'gateway', result.upstreamId);
    }
    return plainResultToResponse(result);
  }

  const state = new SourceStreamState();
  const observed = observeOpenAIChatCompletionsFrames(result.events, state, ctx);
  const frames = wrapOpenAIChatCompletionsAffinityEgress(observed, affinityEgressOptions(ctx));

  if (!wantsStream) {
    try {
      const response = await collectOpenAIChatCompletionsProtocolEventsToResult(frames);
      const metadata = await eventResultMetadata(result);
      const usage = tokenUsageFromBillableUsage(metadata.billableUsage);
      ctx.dump?.success(metadata.modelIdentity, usage);
      settle(ctx, metadata.performance, metadata.modelIdentity, usage, state.failed);
      return Response.json(response, { headers: mergeForwardedUpstreamHeaders(undefined, result.headers) });
    } catch (error) {
      recordFailedRequest(ctx, result.performance);
      ctx.dump?.failed(error);
      return internalOpenAIChatCompletionsErrorResponse(502, toInternalDebugError(error));
    }
  }

  forwardUpstreamHeaders(c, result.headers);
  return streamSSE(c, async stream => {
    let completion: StreamCompletion = 'error';
    try {
      completion = await writeSSEFrames(stream, openaiChatCompletionsSseFrames(frames, includeUsageChunk, state, ctx), {
        keepAlive: { frame: sseCommentFrame('keepalive') },
        ...(ctx.downstreamAbortController !== undefined ? { downstreamAbortController: ctx.downstreamAbortController } : {}),
      });
    } finally {
      const metadata = await eventResultMetadata(result);
      const failed = state.failedAfter(completion);
      if (failed) {
        ctx.dump?.failed(`openai-chat-completions stream failed (completion=${completion}, source-failed=${state.failed})`);
      } else {
        ctx.dump?.success(metadata.modelIdentity, tokenUsageFromBillableUsage(metadata.billableUsage));
      }
      settle(ctx, metadata.performance, metadata.modelIdentity, tokenUsageFromBillableUsage(metadata.billableUsage), failed);
    }
  });
};

// --- error rendering ---

const internalOpenAIChatCompletionsErrorPayload = (error: InternalDebugError) => ({
  error: {
    type: error.type,
    name: error.name,
    message: error.message,
    stack: error.stack,
    cause: error.cause,
    target_api: error.target_api,
  },
});

const internalOpenAIChatCompletionsErrorResponse = (status: number, error: InternalDebugError): Response => Response.json(internalOpenAIChatCompletionsErrorPayload(error), { status });

// --- frame observation ---

const isOpenAIChatCompletionsFailureFrame = (frame: ProtocolFrame<OpenAIChatCompletionsStreamEvent>) => frame.type === 'event' && openaiChatCompletionsErrorPayloadMessage(frame.event) !== null;

const isOpenAIChatCompletionsTerminalFrame = (frame: ProtocolFrame<OpenAIChatCompletionsStreamEvent>) => frame.type === 'done' || isOpenAIChatCompletionsFailureFrame(frame);

const observeOpenAIChatCompletionsFrames = async function* (frames: AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>, state: SourceStreamState, ctx: GatewayCtx) {
  for await (const frame of frames) {
    ctx.dump?.frame(frame);
    const failed = isOpenAIChatCompletionsFailureFrame(frame);
    if (failed) state.failed = true;
    if (isOpenAIChatCompletionsTerminalFrame(frame) && !failed) state.completed = true;
    yield frame;
    if (isOpenAIChatCompletionsTerminalFrame(frame)) return;
  }
  throw new Error(OPENAI_CHAT_COMPLETIONS_MISSING_TERMINAL_MESSAGE);
};

const openaiChatCompletionsSseFrames = async function* (frames: AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>, includeUsageChunk: boolean, state: SourceStreamState, ctx: GatewayCtx) {
  try {
    for await (const frame of frames) {
      const sse = openaiChatCompletionsProtocolFrameToSSEFrame(frame, { includeUsageChunk });
      if (sse) yield sse;
    }
  } catch (error) {
    state.failed = true;
    const event = internalOpenAIChatCompletionsErrorPayload(toInternalDebugError(error)) as unknown as OpenAIChatCompletionsStreamEvent;
    ctx.dump?.frame(eventFrame(event));
    yield sseFrame(JSON.stringify(event), 'error');
  }
};
