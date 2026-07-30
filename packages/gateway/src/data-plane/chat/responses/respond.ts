import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';

import { wrapNativeResponsesClientOutput } from './client-output.ts';
import type { GatewayCtx } from '../../shared/gateway-ctx.ts';
import { type StreamCompletion, writeSSEFrames } from '../../shared/sse.ts';
import { recordFailedRequest } from '../../shared/telemetry/performance.ts';
import { settle } from '../../shared/telemetry/settle.ts';
import { tokenUsageFromBillableUsage } from '../../shared/telemetry/usage.ts';
import { forwardUpstreamHeaders, mergeForwardedUpstreamHeaders } from '../../shared/upstream-response.ts';
import { SourceStreamState, eventResultMetadata, plainResultToResponse } from '../shared/respond.ts';
import { doneFrame, type ProtocolFrame, sseCommentFrame, sseFrame } from '@floway-dev/protocols/common';
import { responsesProtocolFrameToSSEFrame, RESPONSES_MISSING_TERMINAL_MESSAGE, collectResponsesProtocolEventsToResult } from '@floway-dev/protocols/responses';
import { isResponsesTerminalEvent, type ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import { type ExecuteResult, type PlainResult, type InternalDebugError, toInternalDebugError } from '@floway-dev/provider';
import { apiErrorToResponse } from '@floway-dev/provider';

// Renders an upstream Responses result into the client HTTP/SSE response. An
// error-typed result is a pre-stream failure and always answers as HTTP; an
// events result drains to one JSON body (non-streaming) or is proxied frame by
// frame (streaming).
export const respondResponses = async (
  c: Context,
  result: ExecuteResult<ProtocolFrame<ResponsesStreamEvent>> | PlainResult,
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
    return internalResponsesErrorResponse(result.status, result.error);
  }

  if (result.type === 'plain') {
    if (result.status >= 400) {
      ctx.dump?.error(result.upstreamId !== undefined ? 'upstream' : 'gateway', result.upstreamId);
    }
    return plainResultToResponse(result);
  }

  const state = new SourceStreamState();
  const observed = observeResponsesFrames(result.events, state, ctx);
  const frames = wrapNativeResponsesClientOutput(observed, ctx);

  if (!wantsStream) {
    try {
      const response = await collectResponsesProtocolEventsToResult(frames);
      const metadata = await eventResultMetadata(result);
      const usage = tokenUsageFromBillableUsage(metadata.billableUsage);
      ctx.dump?.success(metadata.modelIdentity, usage);
      settle(ctx, metadata.performance, metadata.modelIdentity, usage, state.failed || response.status === 'failed');
      return Response.json(response, { headers: mergeForwardedUpstreamHeaders(undefined, result.headers) });
    } catch (error) {
      recordFailedRequest(ctx, result.performance);
      ctx.dump?.failed(error);
      return internalResponsesErrorResponse(502, toInternalDebugError(error));
    }
  }

  forwardUpstreamHeaders(c, result.headers);
  const response = streamSSE(c, async stream => {
    let completion: StreamCompletion = 'error';
    try {
      completion = await writeSSEFrames(stream, responsesSseFrames(frames, state), {
        keepAlive: { frame: sseCommentFrame('keepalive') },
        ...(ctx.downstreamAbortController !== undefined ? { downstreamAbortController: ctx.downstreamAbortController } : {}),
      });
    } finally {
      const metadata = await eventResultMetadata(result);
      const failed = state.failedAfter(completion);
      if (failed) {
        ctx.dump?.failed(`responses stream failed (completion=${completion}, source-failed=${state.failed})`);
      } else {
        ctx.dump?.success(metadata.modelIdentity, tokenUsageFromBillableUsage(metadata.billableUsage));
      }
      settle(ctx, metadata.performance, metadata.modelIdentity, tokenUsageFromBillableUsage(metadata.billableUsage), failed);
    }
  });

  return response;
};

// --- error rendering ---

const internalResponsesErrorResponse = (status: number, error: InternalDebugError): Response =>
  Response.json({
    error: {
      type: error.type,
      name: error.name,
      message: error.message,
      stack: error.stack,
      cause: error.cause,
      target_api: error.target_api,
    },
  }, { status });

const internalResponsesStreamErrorFrame = (error: unknown) => {
  const debug = toInternalDebugError(error);
  return sseFrame(
    JSON.stringify({
      type: 'error',
      message: debug.message,
      code: debug.type,
      name: debug.name,
      stack: debug.stack,
      cause: debug.cause,
      target_api: debug.target_api,
    }),
    'error',
  );
};

// --- frame observation ---

const isResponsesTerminalFrame = (frame: ProtocolFrame<ResponsesStreamEvent>) => frame.type === 'event' && isResponsesTerminalEvent(frame.event);

const observeResponsesFrames = async function* (frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>, state: SourceStreamState, ctx: GatewayCtx) {
  for await (const frame of frames) {
    ctx.dump?.frame(frame);
    const failed = frame.type === 'event' && (frame.event.type === 'error' || frame.event.type === 'response.failed');
    if (failed) state.failed = true;
    if (isResponsesTerminalFrame(frame) && !failed) state.completed = true;
    yield frame;
    if (isResponsesTerminalFrame(frame)) return;
  }
  throw new Error(RESPONSES_MISSING_TERMINAL_MESSAGE);
};

const responsesSseFrames = async function* (frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>, state: SourceStreamState) {
  try {
    for await (const frame of frames) {
      yield responsesProtocolFrameToSSEFrame(frame);
    }
    // The SSE transport terminates on the literal `[DONE]` payload, per the
    // OpenResponses 2026-04-24 spec, "Streaming HTTP Responses":
    // https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/src/specifications/2026-04-24.mdx?plain=1#L84
    // The terminating frame is appended here rather than by a producer because
    // a Responses stream ends on its terminal event: the client-output boundary
    // and `observeResponsesFrames` both return there, so an upstream `done`
    // frame never survives a completed stream.
    yield responsesProtocolFrameToSSEFrame(doneFrame());
  } catch (error) {
    state.failed = true;
    yield internalResponsesStreamErrorFrame(error);
  }
};
