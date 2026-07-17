import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';

import { wrapNativeResponsesClientOutput } from './client-output.ts';
import { tokenUsageFromResponsesResult } from './usage.ts';
import { recordFailedRequest } from '../../shared/telemetry/performance.ts';
import { settle } from '../../shared/telemetry/settle.ts';
import type { GatewayCtx } from '../shared/gateway-ctx.ts';
import { SourceStreamState, eventResultMetadata, forwardUpstreamHeaders, mergeForwardedUpstreamHeaders, plainResultToResponse } from '../shared/respond.ts';
import { type StreamCompletion, writeSSEFrames } from '../shared/stream/sse.ts';
import { type ProtocolFrame, sseCommentFrame, sseFrame } from '@floway-dev/protocols/common';
import { responsesProtocolFrameToSSEFrame, RESPONSES_MISSING_TERMINAL_MESSAGE, collectResponsesProtocolEventsToResult } from '@floway-dev/protocols/responses';
import { isResponsesTerminalEvent, type ResponsesStreamEvent, responsesResultFromStreamEvent } from '@floway-dev/protocols/responses';
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
    ctx.dump?.error(result.source, result.upstream);
    return apiErrorToResponse(result);
  }

  if (result.type === 'internal-error') {
    recordFailedRequest(ctx, result.performance);
    ctx.dump?.failed(result.error.message);
    return internalResponsesErrorResponse(result.status, result.error);
  }

  if (result.type === 'plain') {
    if (result.status >= 400) {
      ctx.dump?.error(result.upstream !== undefined ? 'upstream' : 'gateway', result.upstream);
    }
    return plainResultToResponse(result);
  }

  const state = new SourceStreamState();
  const observed = observeResponsesFrames(result.events, state, wantsStream, ctx);
  const frames = wrapNativeResponsesClientOutput(observed, ctx);

  if (!wantsStream) {
    try {
      const response = await collectResponsesProtocolEventsToResult(frames);
      const metadata = await eventResultMetadata(result);
      const usage = tokenUsageFromResponsesResult(response);
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
        ctx.dump?.success(metadata.modelIdentity, state.usage);
      }
      settle(ctx, metadata.performance, metadata.modelIdentity, state.usage, failed);
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

const observeResponsesFrames = async function* (frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>, state: SourceStreamState, observeUsage: boolean, ctx: GatewayCtx) {
  for await (const frame of frames) {
    ctx.dump?.frame(frame);
    const failed = frame.type === 'event' && (frame.event.type === 'error' || frame.event.type === 'response.failed');
    if (failed) state.failed = true;
    if (observeUsage) {
      const response = frame.type === 'event' ? responsesResultFromStreamEvent(frame.event) : null;
      state.rememberUsage(response !== null ? tokenUsageFromResponsesResult(response) : null);
    }
    if (isResponsesTerminalFrame(frame) && !failed) state.completed = true;
    yield frame;
    if (isResponsesTerminalFrame(frame)) return;
  }
  throw new Error(RESPONSES_MISSING_TERMINAL_MESSAGE);
};

const responsesSseFrames = async function* (frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>, state: SourceStreamState) {
  try {
    for await (const frame of frames) {
      const sse = responsesProtocolFrameToSSEFrame(frame);
      if (sse) yield sse;
    }
  } catch (error) {
    state.failed = true;
    yield internalResponsesStreamErrorFrame(error);
  }
};
