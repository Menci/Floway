import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';

import { wrapGeminiAffinityEgress } from './affinity/egress.ts';
import { geminiStatusForHttpStatus } from './errors.ts';
import { tokenUsageFromGeminiUsageMetadata } from './usage.ts';
import { recordFailedRequest } from '../../shared/telemetry/performance.ts';
import { settle } from '../../shared/telemetry/settle.ts';
import { affinityEgressOptions } from '../shared/affinity/index.ts';
import type { GatewayCtx } from '../shared/gateway-ctx.ts';
import { SourceStreamState, eventResultMetadata, forwardUpstreamHeaders, mergeForwardedUpstreamHeaders, plainResultToResponse } from '../shared/respond.ts';
import { type StreamCompletion, writeSSEFrames } from '../shared/stream/sse.ts';
import { type ProtocolFrame, sseCommentFrame, sseFrame } from '@floway-dev/protocols/common';
import { geminiProtocolFrameToSSEFrame, GEMINI_MISSING_TERMINAL_MESSAGE, isGeminiErrorEvent, isGeminiTerminalEvent, collectGeminiProtocolEventsToResult } from '@floway-dev/protocols/gemini';
import type { GeminiErrorResponse, GeminiResult, GeminiStreamEvent } from '@floway-dev/protocols/gemini';
import { type ExecuteResult, type PlainResult, type ApiErrorResult, type InternalDebugError, toInternalDebugError, decodeApiErrorBody } from '@floway-dev/provider';

// Renders an upstream Gemini result into the client HTTP/SSE response, in the
// Google-RPC error envelope. An error-typed result is a pre-stream failure and
// always answers as HTTP; an events result drains to one JSON body
// (non-streaming) or is proxied frame by frame (streaming). `success` reports
// whether a non-streaming body was produced, so the orchestrator knows whether
// to flush stored items.
export const respondGemini = async (
  c: Context,
  result: ExecuteResult<ProtocolFrame<GeminiStreamEvent>> | PlainResult,
  wantsStream: boolean,
  ctx: GatewayCtx,
): Promise<{ success: boolean; response: Response }> => {
  if (result.type === 'api-error') {
    recordFailedRequest(ctx, result.performance);
    ctx.dump?.error(result.source, result.upstream);
    return { success: false, response: geminiApiErrorResponse(result) };
  }

  if (result.type === 'internal-error') {
    recordFailedRequest(ctx, result.performance);
    ctx.dump?.failed(result.error.message);
    return { success: false, response: geminiErrorResponse(result.status, result.error.message, internalDebugFields(result.error)) };
  }

  if (result.type === 'plain') {
    if (result.status >= 400) {
      ctx.dump?.error(result.upstream !== undefined ? 'upstream' : 'gateway', result.upstream);
    }
    return { success: true, response: plainResultToResponse(result) };
  }

  const state = new SourceStreamState();
  const observed = observeGeminiFrames(result.events, state, wantsStream, ctx);
  const frames = wrapGeminiAffinityEgress(observed, affinityEgressOptions(ctx));

  if (!wantsStream) {
    try {
      const response = await collectGeminiProtocolEventsToResult(frames);
      const metadata = await eventResultMetadata(result);
      const usage = tokenUsageFromGeminiResponse(response);
      ctx.dump?.success(metadata.modelIdentity, usage);
      settle(ctx, metadata.performance, metadata.modelIdentity, usage, state.failed);
      return { success: true, response: Response.json(response, { headers: mergeForwardedUpstreamHeaders(undefined, result.headers) }) };
    } catch (error) {
      recordFailedRequest(ctx, result.performance);
      ctx.dump?.failed(error);
      return { success: false, response: geminiCollectErrorResponse(error) };
    }
  }

  forwardUpstreamHeaders(c, result.headers);
  const response = streamSSE(c, async stream => {
    let completion: StreamCompletion = 'error';
    try {
      completion = await writeSSEFrames(stream, geminiSseFrames(frames, state), {
        keepAlive: { frame: sseCommentFrame('keepalive') },
        ...(ctx.downstreamAbortController !== undefined ? { downstreamAbortController: ctx.downstreamAbortController } : {}),
      });
    } finally {
      const metadata = await eventResultMetadata(result);
      const failed = state.failedAfter(completion);
      if (failed) {
        ctx.dump?.failed(`gemini stream failed (completion=${completion}, source-failed=${state.failed})`);
      } else {
        ctx.dump?.success(metadata.modelIdentity, state.usage);
      }
      settle(ctx, metadata.performance, metadata.modelIdentity, state.usage, failed);
    }
  });

  return { success: true, response };
};

const tokenUsageFromGeminiResponse = (r: GeminiResult) => (r.usageMetadata ? tokenUsageFromGeminiUsageMetadata(r.usageMetadata) : null);

// --- error rendering: Google-RPC envelope ---

type GeminiErrorDebugFields = Partial<Pick<InternalDebugError, 'type' | 'name' | 'stack' | 'cause'>> & { target_api?: string };

type GeminiErrorStatusPayload = {
  error: GeminiErrorResponse['error'] & GeminiErrorDebugFields;
};

const googleRpcHttpStatusCode = (status: number): number => (Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500);

const geminiRpcErrorPayload = (status: number, message: string, debug: GeminiErrorDebugFields = {}): GeminiErrorStatusPayload => {
  const code = googleRpcHttpStatusCode(status);
  return {
    error: { code, message, status: geminiStatusForHttpStatus(code), ...debug },
  };
};

const internalDebugFields = (error: InternalDebugError): GeminiErrorDebugFields => ({
  type: error.type,
  name: error.name,
  stack: error.stack,
  cause: error.cause,
  ...(error.target_api ? { target_api: error.target_api } : {}),
});

const geminiInternalRpcErrorPayload = (status: number, error: unknown): GeminiErrorStatusPayload => {
  const debug = toInternalDebugError(error);
  return geminiRpcErrorPayload(status, debug.message, internalDebugFields(debug));
};

// Response builders. The count_tokens path under `http.ts` reuses them
// alongside the error renderer for its synthesized JSON envelope.
export const geminiRpcErrorResponse = (status: number, message: string): Response => {
  const payload = geminiRpcErrorPayload(status, message);
  return Response.json(payload, { status: payload.error.code });
};

export const geminiInternalRpcErrorResponse = (status: number, error: unknown): Response => {
  const payload = geminiInternalRpcErrorPayload(status, error);
  return Response.json(payload, { status: payload.error.code });
};

const geminiErrorResponse = (status: number, message: string, debug: GeminiErrorDebugFields = {}): Response => {
  // For gateway-minted errors, a non-500 that maps to INTERNAL is coerced to 500.
  const code = geminiStatusForHttpStatus(status) === 'INTERNAL' && status !== 500 ? 500 : status;
  return Response.json({ error: { code, message, status: geminiStatusForHttpStatus(code), ...debug } }, { status: code });
};

const geminiApiErrorResponse = (error: ApiErrorResult): Response => googleRpcErrorPassthroughResponse(error) ?? geminiErrorResponse(error.status, apiErrorMessage(error));

const geminiCollectErrorResponse = (error: unknown): Response => {
  const geminiError = caughtGeminiErrorEvent(error);
  return geminiError ? Response.json(geminiError, { status: googleRpcHttpStatusCode(geminiError.error.code) }) : geminiInternalRpcErrorResponse(502, error);
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

const isGeminiErrorResponse = (value: unknown): value is GeminiErrorResponse => {
  if (!value || typeof value !== 'object' || !('error' in value)) return false;
  const error = (value as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return false;
  const payload = error as Partial<GeminiErrorResponse['error']>;
  return typeof payload.code === 'number' && typeof payload.message === 'string' && typeof payload.status === 'string';
};

const googleRpcErrorPassthroughResponse = (error: ApiErrorResult): Response | null => {
  const parsed = parseJson(decodeApiErrorBody(error).trim());
  if (!isGeminiErrorResponse(parsed)) return null;

  return new Response(error.body.slice(), {
    status: googleRpcHttpStatusCode(parsed.error.code),
    headers: new Headers(error.headers),
  });
};

const apiErrorMessage = (error: ApiErrorResult): string => {
  const body = decodeApiErrorBody(error).trim();
  return body || 'Upstream Gemini request failed.';
};

const caughtGeminiErrorEvent = (error: unknown): GeminiErrorResponse | null => {
  if (!(error instanceof Error)) return null;
  return isGeminiErrorResponse(error.cause) ? error.cause : null;
};

const geminiStreamErrorFrame = (error: unknown) => sseFrame(JSON.stringify(caughtGeminiErrorEvent(error) ?? geminiInternalRpcErrorPayload(500, error)));

// --- frame observation ---

const isGeminiTerminalFrame = (frame: ProtocolFrame<GeminiStreamEvent>): boolean => frame.type === 'done' || (frame.type === 'event' && isGeminiTerminalEvent(frame.event));

const observeGeminiFrames = async function* (frames: AsyncIterable<ProtocolFrame<GeminiStreamEvent>>, state: SourceStreamState, observeUsage: boolean, ctx: GatewayCtx) {
  for await (const frame of frames) {
    ctx.dump?.frame(frame);
    const failed = frame.type === 'event' && isGeminiErrorEvent(frame.event);
    if (failed) state.failed = true;
    if (observeUsage) {
      state.rememberUsage(frame.type === 'event' && !('error' in frame.event) ? tokenUsageFromGeminiResponse(frame.event) : null);
    }
    if (isGeminiTerminalFrame(frame) && !failed) state.completed = true;
    yield frame;
    if (isGeminiTerminalFrame(frame)) return;
  }
  throw new Error(GEMINI_MISSING_TERMINAL_MESSAGE);
};

const geminiSseFrames = async function* (frames: AsyncIterable<ProtocolFrame<GeminiStreamEvent>>, state: SourceStreamState) {
  try {
    for await (const frame of frames) {
      const sse = geminiProtocolFrameToSSEFrame(frame);
      if (sse) yield sse;
    }
  } catch (error) {
    state.failed = true;
    yield geminiStreamErrorFrame(error);
  }
};
