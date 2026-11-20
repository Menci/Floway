import type { Context } from 'hono';

import { wrapGeminiGenerateContentAffinityEgress } from './affinity/egress.ts';
import { geminiGenerateContentInternalErrorPayload, geminiGenerateContentRpcErrorPayload, googleRpcHttpStatusCode, isGeminiGenerateContentErrorResponse } from './errors.ts';
import type { GatewayCtx } from '../../shared/gateway-ctx.ts';
import { serializeSseFrame, serveSse } from '../../shared/sse.ts';
import { recordFailedRequest } from '../../shared/telemetry/performance.ts';
import { settle } from '../../shared/telemetry/settle.ts';
import { tokenUsageFromBillableUsage } from '../../shared/telemetry/usage.ts';
import { forwardBufferedUpstreamResponse } from '../../shared/upstream-response.ts';
import { affinityEgressOptions } from '../shared/affinity/index.ts';
import { eventResultMetadata, jsonResponseInit, observeChatFrames, settleChatSse } from '../shared/respond.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
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

  const observed = observeChatFrames(result.events, ctx);
  const affinity = affinityEgressOptions(ctx);

  if (!wantsStream) {
    try {
      const response = await collectGeminiGenerateContentProtocolEventsToResult(wrapGeminiGenerateContentAffinityEgress(observed, affinity));
      const metadata = await eventResultMetadata(result);
      const usage = tokenUsageFromBillableUsage(metadata.billableUsage);
      ctx.dump?.success(metadata.modelIdentity, usage);
      settle(ctx, metadata.performance, metadata.modelIdentity, usage, false);
      return Response.json(response, jsonResponseInit(result.http));
    } catch (error) {
      recordFailedRequest(ctx, result.performance);
      ctx.dump?.failed(error);
      return geminiGenerateContentCollectErrorResponse(error);
    }
  }

  const completion = createGeminiGenerateContentCandidateCompletion();
  let upstreamTerminal: ReturnType<typeof geminiSseTerminal>;
  // Affinity can hold a frame while looking ahead. Cancellation settles what
  // the upstream finished, including candidates the wrapper has buffered.
  const upstream = (async function* () {
    for await (const frame of observed) {
      upstreamTerminal = geminiSseTerminal(frame);
      if (frame.type === 'event' && upstreamTerminal === undefined) completion.observe(frame.event);
      yield frame;
      if (upstreamTerminal !== undefined) return;
    }
  })();
  const upstreamCompleted = () => upstreamTerminal === 'completed' || (upstreamTerminal === undefined && completion.isComplete());

  return serveSse(c, {
    http: result.http,
    events: wrapGeminiGenerateContentAffinityEgress(upstream, affinity),
    downstreamAbortController: ctx.downstreamAbortController,
    protocol: {
      encode: frame => {
        const output = geminiGenerateContentProtocolFrameToSSEFrame(frame);
        const wire = output === null ? null : serializeSseFrame(output);
        const terminal = geminiSseTerminal(frame);
        return terminal === undefined ? { wire } : { wire, end: { type: terminal } };
      },
      eof: () => upstreamCompleted()
        ? { type: 'completed' }
        : { type: 'premature-eof', error: new Error(GEMINI_GENERATE_CONTENT_MISSING_TERMINAL_MESSAGE) },
      failure: error => {
        const frame = eventFrame(caughtGeminiGenerateContentErrorEvent(error) ?? geminiGenerateContentInternalRpcErrorPayload(500, error));
        ctx.dump?.frame(frame);
        return [serializeSseFrame(geminiGenerateContentProtocolFrameToSSEFrame(frame)!)];
      },
    },
    settle: outcome => settleChatSse(ctx, result, outcome.type === 'cancelled' && upstreamCompleted() ? { type: 'completed' } : outcome),
  });
};

const geminiSseTerminal = (frame: ProtocolFrame<GeminiGenerateContentStreamEvent>): 'completed' | 'protocol-error' | undefined => {
  if (frame.type === 'done') return 'completed';
  if (isGeminiGenerateContentErrorEvent(frame.event)) return 'protocol-error';
  if (isGeminiGenerateContentTerminalEvent(frame.event)) return 'completed';
  return undefined;
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
