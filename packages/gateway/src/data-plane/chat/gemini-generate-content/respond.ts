import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';

import { wrapGeminiGenerateContentAffinityEgress } from './affinity/egress.ts';
import { geminiGenerateContentInternalErrorPayload, geminiGenerateContentRpcErrorPayload, googleRpcHttpStatusCode, isGeminiGenerateContentErrorResponse } from './errors.ts';
import type { GatewayCtx } from '../../shared/gateway-ctx.ts';
import { type StreamCompletion, writeSSEFrames } from '../../shared/sse.ts';
import { recordFailedRequest } from '../../shared/telemetry/performance.ts';
import { settle } from '../../shared/telemetry/settle.ts';
import { tokenUsageFromBillableUsage } from '../../shared/telemetry/usage.ts';
import { forwardBufferedUpstreamResponse, prepareSseResponse } from '../../shared/upstream-response.ts';
import { affinityEgressOptions } from '../shared/affinity/index.ts';
import { SourceStreamState, eventResultMetadata, jsonResponseInit } from '../shared/respond.ts';
import { eventFrame, type ProtocolFrame, sseCommentFrame } from '@floway-dev/protocols/common';
import { geminiGenerateContentProtocolFrameToSSEFrame, GEMINI_GENERATE_CONTENT_MISSING_TERMINAL_MESSAGE, createGeminiGenerateContentCandidateCompletion, isGeminiGenerateContentErrorEvent, isGeminiGenerateContentTerminalEvent, collectGeminiGenerateContentProtocolEventsToResult } from '@floway-dev/protocols/gemini-generate-content';
import type { GeminiGenerateContentErrorResponse, GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import { type ExecuteResult, type PlainResult, toInternalDebugError } from '@floway-dev/provider';

// Renders an upstream Gemini generateContent result into the client HTTP/SSE response, in the
// Google-RPC error envelope. An error-typed result is a pre-stream failure and
// always answers as HTTP; an events result drains to one JSON body
// (non-streaming) or is proxied frame by frame (streaming).
export const respondGeminiGenerateContent = async (
  c: Context,
  result: ExecuteResult<ProtocolFrame<GeminiGenerateContentStreamEvent>> | PlainResult,
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
    return Response.json(geminiGenerateContentInternalErrorPayload(result.http.status, result.error), result.http);
  }

  if (result.type === 'plain') {
    if (result.http.status >= 400) {
      ctx.dump?.error(result.upstreamId !== undefined ? 'upstream' : 'gateway', result.upstreamId);
    }
    return forwardBufferedUpstreamResponse(result);
  }

  const state = new SourceStreamState();
  const observed = observeGeminiGenerateContentFrames(result.events, state, ctx);
  const frames = wrapGeminiGenerateContentAffinityEgress(observed, affinityEgressOptions(ctx));

  if (!wantsStream) {
    try {
      const response = await collectGeminiGenerateContentProtocolEventsToResult(frames);
      const metadata = await eventResultMetadata(result);
      const usage = tokenUsageFromBillableUsage(metadata.billableUsage);
      ctx.dump?.success(metadata.modelIdentity, usage);
      settle(ctx, metadata.performance, metadata.modelIdentity, usage, state.failed);
      return Response.json(response, jsonResponseInit(result.http));
    } catch (error) {
      recordFailedRequest(ctx, result.performance);
      ctx.dump?.failed(error);
      return geminiGenerateContentCollectErrorResponse(error);
    }
  }

  prepareSseResponse(c, result.http);
  return streamSSE(c, async stream => {
    let completion: StreamCompletion = 'error';
    try {
      completion = await writeSSEFrames(stream, geminiGenerateContentSseFrames(frames, state, ctx), {
        keepAlive: { frame: sseCommentFrame('keepalive') },
        ...(ctx.downstreamAbortController !== undefined ? { downstreamAbortController: ctx.downstreamAbortController } : {}),
      });
    } finally {
      const metadata = await eventResultMetadata(result);
      const failed = state.failedAfter(completion);
      if (failed) {
        ctx.dump?.failed(`gemini stream failed (completion=${completion}, source-failed=${state.failed})`);
      } else {
        ctx.dump?.success(metadata.modelIdentity, tokenUsageFromBillableUsage(metadata.billableUsage));
      }
      settle(ctx, metadata.performance, metadata.modelIdentity, tokenUsageFromBillableUsage(metadata.billableUsage), failed);
    }
  });
};

// --- error rendering: Google-RPC envelope ---

const geminiGenerateContentInternalRpcErrorPayload = (status: number, error: unknown): GeminiGenerateContentErrorResponse =>
  geminiGenerateContentInternalErrorPayload(googleRpcHttpStatusCode(status), toInternalDebugError(error));

// Response builders. The count_tokens path under `http.ts` reuses them
// alongside the error renderer for its synthesized JSON envelope.
export const geminiGenerateContentRpcErrorResponse = (status: number, message: string): Response => {
  const payload = geminiGenerateContentRpcErrorPayload(status, message);
  return Response.json(payload, { status: payload.error.code });
};

export const geminiGenerateContentInternalRpcErrorResponse = (status: number, error: unknown): Response => {
  const payload = geminiGenerateContentInternalRpcErrorPayload(status, error);
  return Response.json(payload, { status: payload.error.code });
};

const geminiGenerateContentCollectErrorResponse = (error: unknown): Response => {
  const geminiGenerateContentError = caughtGeminiGenerateContentErrorEvent(error);
  return geminiGenerateContentError
    ? Response.json(geminiGenerateContentError, { status: googleRpcHttpStatusCode(geminiGenerateContentError.error.code) })
    : geminiGenerateContentInternalRpcErrorResponse(502, error);
};

const caughtGeminiGenerateContentErrorEvent = (error: unknown): GeminiGenerateContentErrorResponse | null => {
  if (!(error instanceof Error)) return null;
  return isGeminiGenerateContentErrorResponse(error.cause) ? error.cause : null;
};

const geminiGenerateContentStreamErrorEvent = (error: unknown): GeminiGenerateContentStreamEvent =>
  (caughtGeminiGenerateContentErrorEvent(error) ?? geminiGenerateContentInternalRpcErrorPayload(500, error)) as unknown as GeminiGenerateContentStreamEvent;

// --- frame observation ---

const isGeminiGenerateContentTerminalFrame = (frame: ProtocolFrame<GeminiGenerateContentStreamEvent>): boolean => frame.type === 'done' || (frame.type === 'event' && isGeminiGenerateContentTerminalEvent(frame.event));

const observeGeminiGenerateContentFrames = async function* (frames: AsyncIterable<ProtocolFrame<GeminiGenerateContentStreamEvent>>, state: SourceStreamState, ctx: GatewayCtx) {
  const completion = createGeminiGenerateContentCandidateCompletion();
  for await (const frame of frames) {
    ctx.dump?.frame(frame);
    const failed = frame.type === 'event' && isGeminiGenerateContentErrorEvent(frame.event);
    if (failed) state.failed = true;
    if (frame.type === 'event') completion.observe(frame.event);
    if (!failed) state.completed = isGeminiGenerateContentTerminalFrame(frame) || completion.isComplete();
    yield frame;
    if (isGeminiGenerateContentTerminalFrame(frame)) return;
  }
  if (!state.completed) throw new Error(GEMINI_GENERATE_CONTENT_MISSING_TERMINAL_MESSAGE);
};

const geminiGenerateContentSseFrames = async function* (frames: AsyncIterable<ProtocolFrame<GeminiGenerateContentStreamEvent>>, state: SourceStreamState, ctx: GatewayCtx) {
  try {
    for await (const frame of frames) {
      const sse = geminiGenerateContentProtocolFrameToSSEFrame(frame);
      if (sse) yield sse;
    }
  } catch (error) {
    state.failed = true;
    const event = geminiGenerateContentStreamErrorEvent(error);
    ctx.dump?.frame(eventFrame(event));
    yield geminiGenerateContentProtocolFrameToSSEFrame(eventFrame(event))!;
  }
};
