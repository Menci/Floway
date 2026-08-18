import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';

import { wrapGeminiGenerateContentAffinityEgress } from './affinity/egress.ts';
import { geminiGenerateContentStatusForHttpStatus } from './errors.ts';
import type { GatewayCtx } from '../../shared/gateway-ctx.ts';
import { type StreamCompletion, writeSSEFrames } from '../../shared/sse.ts';
import { recordFailedRequest } from '../../shared/telemetry/performance.ts';
import { settle } from '../../shared/telemetry/settle.ts';
import { tokenUsageFromBillableUsage } from '../../shared/telemetry/usage.ts';
import { forwardUpstreamHeaders, mergeForwardedUpstreamHeaders } from '../../shared/upstream-response.ts';
import { affinityEgressOptions } from '../shared/affinity/index.ts';
import { SourceStreamState, eventResultMetadata, plainResultToResponse } from '../shared/respond.ts';
import { eventFrame, type ProtocolFrame, sseCommentFrame, sseFrame } from '@floway-dev/protocols/common';
import { geminiGenerateContentProtocolFrameToSSEFrame, GEMINI_GENERATE_CONTENT_MISSING_TERMINAL_MESSAGE, isGeminiGenerateContentErrorEvent, isGeminiGenerateContentTerminalEvent, collectGeminiGenerateContentProtocolEventsToResult } from '@floway-dev/protocols/gemini-generate-content';
import type { GeminiGenerateContentErrorResponse, GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import { type ExecuteResult, type PlainResult, type ApiErrorResult, type InternalDebugError, toInternalDebugError, decodeApiErrorBody } from '@floway-dev/provider';

// Renders an upstream Gemini result into the client HTTP/SSE response, in the
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
    return geminiGenerateContentApiErrorResponse(result);
  }

  if (result.type === 'internal-error') {
    recordFailedRequest(ctx, result.performance);
    ctx.dump?.failed(result.error.message);
    return geminiGenerateContentErrorResponse(result.status, result.error.message, internalDebugFields(result.error));
  }

  if (result.type === 'plain') {
    if (result.status >= 400) {
      ctx.dump?.error(result.upstreamId !== undefined ? 'upstream' : 'gateway', result.upstreamId);
    }
    return plainResultToResponse(result);
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
      return Response.json(response, { headers: mergeForwardedUpstreamHeaders(undefined, result.headers) });
    } catch (error) {
      recordFailedRequest(ctx, result.performance);
      ctx.dump?.failed(error);
      return geminiGenerateContentCollectErrorResponse(error);
    }
  }

  forwardUpstreamHeaders(c, result.headers);
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

type GeminiGenerateContentErrorDebugFields = Partial<Pick<InternalDebugError, 'type' | 'name' | 'stack' | 'cause'>> & { target_api?: string };

type GeminiGenerateContentErrorStatusPayload = {
  error: GeminiGenerateContentErrorResponse['error'] & GeminiGenerateContentErrorDebugFields;
};

const googleRpcHttpStatusCode = (status: number): number => (Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500);

const geminiGenerateContentRpcErrorPayload = (status: number, message: string, debug: GeminiGenerateContentErrorDebugFields = {}): GeminiGenerateContentErrorStatusPayload => {
  const code = googleRpcHttpStatusCode(status);
  return {
    error: { code, message, status: geminiGenerateContentStatusForHttpStatus(code), ...debug },
  };
};

const internalDebugFields = (error: InternalDebugError): GeminiGenerateContentErrorDebugFields => ({
  type: error.type,
  name: error.name,
  stack: error.stack,
  cause: error.cause,
  ...(error.target_api ? { target_api: error.target_api } : {}),
});

const geminiGenerateContentInternalRpcErrorPayload = (status: number, error: unknown): GeminiGenerateContentErrorStatusPayload => {
  const debug = toInternalDebugError(error);
  return geminiGenerateContentRpcErrorPayload(status, debug.message, internalDebugFields(debug));
};

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

const geminiGenerateContentErrorResponse = (status: number, message: string, debug: GeminiGenerateContentErrorDebugFields = {}): Response => {
  // For gateway-minted errors, a non-500 that maps to INTERNAL is coerced to 500.
  const code = geminiGenerateContentStatusForHttpStatus(status) === 'INTERNAL' && status !== 500 ? 500 : status;
  return Response.json({ error: { code, message, status: geminiGenerateContentStatusForHttpStatus(code), ...debug } }, { status: code });
};

const geminiGenerateContentApiErrorResponse = (error: ApiErrorResult): Response => googleRpcErrorPassthroughResponse(error) ?? geminiGenerateContentErrorResponse(error.status, apiErrorMessage(error));

const geminiGenerateContentCollectErrorResponse = (error: unknown): Response => {
  const geminiError = caughtGeminiGenerateContentErrorEvent(error);
  return geminiError ? Response.json(geminiError, { status: googleRpcHttpStatusCode(geminiError.error.code) }) : geminiGenerateContentInternalRpcErrorResponse(502, error);
};

// Recognizing / extracting an upstream-shaped Gemini error from a raw body or a
// thrown cause, so a native Google error is forwarded verbatim rather than
// re-wrapped.
const parseJson = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

const isGeminiGenerateContentErrorResponse = (value: unknown): value is GeminiGenerateContentErrorResponse => {
  if (!value || typeof value !== 'object' || !('error' in value)) return false;
  const error = (value as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return false;
  const payload = error as Partial<GeminiGenerateContentErrorResponse['error']>;
  return typeof payload.code === 'number' && typeof payload.message === 'string' && typeof payload.status === 'string';
};

const googleRpcErrorPassthroughResponse = (error: ApiErrorResult): Response | null => {
  const parsed = parseJson(decodeApiErrorBody(error).trim());
  if (!isGeminiGenerateContentErrorResponse(parsed)) return null;

  return new Response(error.body.slice(), {
    status: googleRpcHttpStatusCode(parsed.error.code),
    headers: new Headers(error.headers),
  });
};

const apiErrorMessage = (error: ApiErrorResult): string => {
  const body = decodeApiErrorBody(error).trim();
  return body || 'Upstream Gemini request failed.';
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
  for await (const frame of frames) {
    ctx.dump?.frame(frame);
    const failed = frame.type === 'event' && isGeminiGenerateContentErrorEvent(frame.event);
    if (failed) state.failed = true;
    if (isGeminiGenerateContentTerminalFrame(frame) && !failed) state.completed = true;
    yield frame;
    if (isGeminiGenerateContentTerminalFrame(frame)) return;
  }
  throw new Error(GEMINI_GENERATE_CONTENT_MISSING_TERMINAL_MESSAGE);
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
    yield sseFrame(JSON.stringify(event));
  }
};
