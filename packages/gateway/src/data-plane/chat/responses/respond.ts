import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';

import { wrapResponsesClientEgress } from './client-output.ts';
import type { GatewayCtx } from '../../shared/gateway-ctx.ts';
import { type StreamCompletion, writeSSEFrames } from '../../shared/sse.ts';
import { recordFailedRequest } from '../../shared/telemetry/performance.ts';
import { settle } from '../../shared/telemetry/settle.ts';
import { tokenUsageFromBillableUsage } from '../../shared/telemetry/usage.ts';
import { forwardUpstreamHeaders, mergeForwardedUpstreamHeaders } from '../../shared/upstream-response.ts';
import { SourceStreamState, eventResultMetadata, plainResultToResponse } from '../shared/respond.ts';
import { doneFrame, eventFrame, type ProtocolFrame, sseCommentFrame, sseFrame } from '@floway-dev/protocols/common';
import { responsesProtocolFrameToSSEFrame, RESPONSES_MISSING_TERMINAL_MESSAGE, collectResponsesProtocolEventsToResult } from '@floway-dev/protocols/responses';
import { isResponsesTerminalEvent, type CanonicalResponsesPayload, type ClientResponseResource, type ClientResponsesStreamEvent, type ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import { type ExecuteResult, type PlainResult, type InternalDebugError, toInternalDebugError } from '@floway-dev/provider';
import { apiErrorToResponse } from '@floway-dev/provider';

// Renders a Responses failure that never opened a stream. Separate entry
// because a request that fails before its payload parses has no payload to
// answer with, and the events path below requires one.
export const respondResponsesFailure = (
  result: Exclude<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>, { type: 'events' }> | PlainResult,
  ctx: GatewayCtx,
): Response => {
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

  if (result.status >= 400) {
    ctx.dump?.error(result.upstreamId !== undefined ? 'upstream' : 'gateway', result.upstreamId);
  }
  return plainResultToResponse(result);
};

// Renders an upstream Responses result into the client HTTP/SSE response. An
// events result drains to one JSON body (non-streaming) or is proxied frame by
// frame (streaming); anything else is a pre-stream failure.
export const respondResponses = async (
  c: Context,
  result: ExecuteResult<ProtocolFrame<ResponsesStreamEvent>> | PlainResult,
  wantsStream: boolean,
  ctx: GatewayCtx,
  request: CanonicalResponsesPayload,
): Promise<Response> => {
  if (result.type !== 'events') return respondResponsesFailure(result, ctx);

  const state = new SourceStreamState();
  const observed = observeResponsesFrames(result.events, state, ctx);
  const frames = wrapResponsesClientEgress(observed, ctx, request);

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
      completion = await writeSSEFrames(stream, responsesSseFrames(frames, state, ctx), {
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

// The spec nests the `error` event's payload under `error`, and both official
// SDKs key their mid-stream throw on exactly that key; the same fields at the
// top level are yielded to them as an ordinary event instead.
// https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/src/specifications/2026-04-24.mdx#L170-L177
// https://github.com/openai/openai-node/blob/d77cf24d9f3885739c6cba76bc009abf0ab97428/src/core/streaming.ts#L69-L71
// https://github.com/openai/openai-python/blob/3844843c277f42b0b18beaa58152cfda61df524a/src/openai/_streaming.py#L87-L98
const internalResponsesStreamErrorEvent = (error: unknown): ClientResponsesStreamEvent => {
  const debug = toInternalDebugError(error);
  return {
    type: 'error',
    error: {
      message: debug.message,
      code: debug.type,
      name: debug.name,
      stack: debug.stack,
      cause: debug.cause,
      target_api: debug.target_api,
    },
  } as unknown as ClientResponsesStreamEvent;
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

// "Any error incurred while streaming will be followed by a `response.failed`
// event."
// https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/src/specifications/2026-04-24.mdx#L430
const responsesFailedEvent = (resource: ClientResponseResource, error: unknown): ClientResponsesStreamEvent => {
  const debug = toInternalDebugError(error);
  return {
    type: 'response.failed',
    response: { ...resource, status: 'failed', error: { code: debug.type, message: debug.message } },
  } as ClientResponsesStreamEvent;
};

const responsesSseFrames = async function* (frames: AsyncIterable<ProtocolFrame<ClientResponsesStreamEvent>>, state: SourceStreamState, ctx: GatewayCtx) {
  let announced: ClientResponseResource | undefined;
  try {
    for await (const frame of frames) {
      if (frame.type === 'event' && 'response' in frame.event) announced = frame.event.response;
      yield responsesProtocolFrameToSSEFrame(frame);
    }
    // The SSE transport terminates on the literal `[DONE]` payload:
    // https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/src/specifications/2026-04-24.mdx?plain=1#L84
    yield responsesProtocolFrameToSSEFrame(doneFrame());
  } catch (error) {
    state.failed = true;
    const errorEvent = internalResponsesStreamErrorEvent(error);
    ctx.dump?.frame(eventFrame(errorEvent));
    yield sseFrame(JSON.stringify(errorEvent), 'error');
    if (announced !== undefined) {
      const failedFrame = eventFrame(responsesFailedEvent(announced, error));
      ctx.dump?.frame(failedFrame);
      yield responsesProtocolFrameToSSEFrame(failedFrame);
    }
  }
};
