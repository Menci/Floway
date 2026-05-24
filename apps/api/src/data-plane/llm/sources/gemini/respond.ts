import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';

import { GEMINI_MISSING_TERMINAL_MESSAGE, isGeminiErrorEvent, isGeminiTerminalEvent, collectGeminiProtocolEventsToResponse } from './events/to-response.ts';
import { geminiProtocolFrameToSSEFrame } from './events/to-sse.ts';
import { tokenUsage } from '../../../shared/telemetry/usage.ts';
import type { RequestContext } from '../../interceptors.ts';
import { type InternalDebugError, toInternalDebugError } from '../../shared/errors/internal-debug-error.ts';
import type { ExecuteResult, UpstreamErrorResult } from '../../shared/errors/result.ts';
import { decodeUpstreamErrorBody } from '../../shared/errors/upstream-error.ts';
import { type StreamCompletion, writeSSEFrames } from '../../shared/stream/proxy-sse.ts';
import { createSourceStreamState, eventResultMetadata, recordSourcePerformance, recordSourceUsage, rememberSourceFrameUsage, sourceStreamFailed } from '../respond.ts';
import { type ProtocolFrame, sseCommentFrame, sseFrame } from '@floway-dev/protocols/common';
import type { GeminiErrorResponse, GeminiGenerateContentResponse, GeminiStreamEvent, GeminiUsageMetadata } from '@floway-dev/protocols/gemini';

type GE = GeminiStreamEvent;
type GR = GeminiGenerateContentResponse;

export const tokenUsageFromGeminiUsageMetadata = (m: GeminiUsageMetadata) => {
  const input = m.promptTokenCount ?? 0;
  const output = (m.candidatesTokenCount ?? 0) + (m.thoughtsTokenCount ?? 0);
  return tokenUsage(input, output, m.cachedContentTokenCount ?? 0);
};

export const tokenUsageFromGeminiResponse = (r: GR) => (r.usageMetadata ? tokenUsageFromGeminiUsageMetadata(r.usageMetadata) : null);

export const tokenUsageFromGeminiFrame = (f: ProtocolFrame<GE>) => (f.type === 'event' && !('error' in f.event) ? tokenUsageFromGeminiResponse(f.event) : null);

const geminiStatusForHttpStatus = (status: number): string => {
  switch (status) {
  case 400:
    return 'INVALID_ARGUMENT';
  case 401:
    return 'UNAUTHENTICATED';
  case 403:
    return 'PERMISSION_DENIED';
  case 404:
    return 'NOT_FOUND';
  case 429:
    return 'RESOURCE_EXHAUSTED';
  case 500:
    return 'INTERNAL';
  case 502:
  case 503:
    return 'UNAVAILABLE';
  default:
    return 'INTERNAL';
  }
};

const downstreamSSECommentKeepAliveFrame = sseCommentFrame('keepalive');

type GeminiErrorDebugFields = Partial<Pick<InternalDebugError, 'type' | 'name' | 'stack' | 'cause'>> & { source_api?: string; target_api?: string };

type GeminiErrorStatusPayload = {
  error: GeminiErrorResponse['error'] & GeminiErrorDebugFields;
};

const isSaneErrorHttpStatus = (status: number): boolean => Number.isInteger(status) && status >= 400 && status <= 599;

const synthesizedGeminiHttpStatusCode = (status: number): number => (geminiStatusForHttpStatus(status) === 'INTERNAL' && status !== 500 ? 500 : status);

const googleRpcHttpStatusCode = (status: number): number => (isSaneErrorHttpStatus(status) ? status : 500);

const geminiRpcErrorPayload = (status: number, message: string, debug: GeminiErrorDebugFields = {}): GeminiErrorStatusPayload => {
  const code = googleRpcHttpStatusCode(status);
  return {
    error: { code, message, status: geminiStatusForHttpStatus(code), ...debug },
  };
};

export const geminiRpcErrorResponse = (status: number, message: string): Response => {
  const payload = geminiRpcErrorPayload(status, message);
  return Response.json(payload, { status: payload.error.code });
};

const geminiErrorPayload = (status: number, message: string, debug: GeminiErrorDebugFields = {}): GeminiErrorStatusPayload => {
  const code = synthesizedGeminiHttpStatusCode(status);
  return {
    error: { code, message, status: geminiStatusForHttpStatus(code), ...debug },
  };
};

const geminiErrorResponse = (status: number, message: string, debug: GeminiErrorDebugFields = {}): Response => {
  const payload = geminiErrorPayload(status, message, debug);
  return Response.json(payload, { status: payload.error.code });
};

const geminiErrorEventResponse = (event: GeminiErrorResponse): Response => Response.json(event, { status: googleRpcHttpStatusCode(event.error.code) });

const geminiErrorEventFrame = (event: GeminiErrorStatusPayload) => sseFrame(JSON.stringify(event));

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

const upstreamGoogleRpcErrorResponse = (error: UpstreamErrorResult): Response | null => {
  const parsed = parseJson(decodeUpstreamErrorBody(error).trim());
  if (!isGeminiErrorResponse(parsed)) return null;

  return new Response(error.body.slice(), {
    status: googleRpcHttpStatusCode(parsed.error.code),
    headers: new Headers(error.headers),
  });
};

const upstreamErrorMessage = (error: UpstreamErrorResult): string => {
  const body = decodeUpstreamErrorBody(error).trim();
  return body || 'Upstream Gemini request failed.';
};

const caughtGeminiErrorEvent = (error: unknown): GeminiErrorResponse | null => {
  if (!(error instanceof Error)) return null;
  return isGeminiErrorResponse(error.cause) ? error.cause : null;
};

const internalDebugFields = (error: InternalDebugError): GeminiErrorDebugFields => ({
  type: error.type,
  name: error.name,
  stack: error.stack,
  cause: error.cause,
  source_api: error.source_api,
  ...(error.target_api ? { target_api: error.target_api } : {}),
});

const geminiInternalRpcErrorPayload = (status: number, error: unknown): GeminiErrorStatusPayload => {
  const debug = toInternalDebugError(error, 'gemini');
  return geminiRpcErrorPayload(status, debug.message, internalDebugFields(debug));
};

export const geminiInternalRpcErrorResponse = (status: number, error: unknown): Response => {
  const payload = geminiInternalRpcErrorPayload(status, error);
  return Response.json(payload, { status: payload.error.code });
};

const isGeminiFailureEvent = (event: GeminiStreamEvent): boolean => isGeminiErrorEvent(event);

const isGeminiTerminalFrame = (frame: ProtocolFrame<GeminiStreamEvent>): boolean => frame.type === 'done' || (frame.type === 'event' && isGeminiTerminalEvent(frame.event));

const internalGeminiErrorResponse = (status: number, error: InternalDebugError): Response => geminiErrorResponse(status, error.message, internalDebugFields(error));

const geminiUpstreamErrorResponse = (error: UpstreamErrorResult): Response => upstreamGoogleRpcErrorResponse(error) ?? geminiErrorResponse(error.status, upstreamErrorMessage(error));

const geminiCollectErrorResponse = (error: unknown): Response => {
  const geminiError = caughtGeminiErrorEvent(error);
  return geminiError ? geminiErrorEventResponse(geminiError) : geminiInternalRpcErrorResponse(502, error);
};

const geminiStreamErrorFrame = (error: unknown) => geminiErrorEventFrame(caughtGeminiErrorEvent(error) ?? geminiInternalRpcErrorPayload(500, error));

const observeGeminiFrames = async function* (frames: AsyncIterable<ProtocolFrame<GeminiStreamEvent>>, state: ReturnType<typeof createSourceStreamState>, observeUsage: boolean) {
  for await (const frame of frames) {
    const failed = frame.type === 'event' && isGeminiFailureEvent(frame.event);
    if (failed) state.failed = true;
    if (observeUsage) {
      rememberSourceFrameUsage(state, tokenUsageFromGeminiFrame(frame));
    }
    if (isGeminiTerminalFrame(frame) && !failed) state.completed = true;
    yield frame;
    if (isGeminiTerminalFrame(frame)) return;
  }
  throw new Error(GEMINI_MISSING_TERMINAL_MESSAGE);
};

const geminiSseFrames = async function* (frames: AsyncIterable<ProtocolFrame<GeminiStreamEvent>>, state: ReturnType<typeof createSourceStreamState>) {
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

export const respondGemini = async (
  c: Context,
  result: ExecuteResult<ProtocolFrame<GeminiStreamEvent>>,
  wantsStream: boolean,
  request: RequestContext,
  downstreamAbortController: AbortController | undefined,
): Promise<Response> => {
  if (result.type === 'upstream-error') {
    recordSourcePerformance(request, result.performance, true);
    return geminiUpstreamErrorResponse(result);
  }

  if (result.type === 'internal-error') {
    recordSourcePerformance(request, result.performance, true);
    return internalGeminiErrorResponse(result.status, result.error);
  }

  const state = createSourceStreamState();
  const frames = observeGeminiFrames(result.events, state, wantsStream);

  if (!wantsStream) {
    try {
      const response = await collectGeminiProtocolEventsToResponse(frames);
      const metadata = await eventResultMetadata(result);
      await recordSourceUsage(request, metadata.modelIdentity, tokenUsageFromGeminiResponse(response));
      recordSourcePerformance(request, metadata.performance, state.failed);
      return Response.json(response);
    } catch (error) {
      recordSourcePerformance(request, result.performance, true);
      return geminiCollectErrorResponse(error);
    }
  }

  return streamSSE(c, async stream => {
    let completion: StreamCompletion = 'error';
    try {
      completion = await writeSSEFrames(stream, geminiSseFrames(frames, state), {
        keepAlive: { frame: downstreamSSECommentKeepAliveFrame },
        downstreamAbortController,
      });
    } finally {
      const metadata = await eventResultMetadata(result);
      try {
        await recordSourceUsage(request, metadata.modelIdentity, state.usage);
      } finally {
        recordSourcePerformance(request, metadata.performance, sourceStreamFailed(completion, state));
      }
    }
  });
};
