import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';

import { wrapOpenAIResponsesClientEgress } from './client-output.ts';
import { OPENAI_RESPONSES_REASONING_INCLUDED_HEADER, OPENAI_RESPONSES_REASONING_INCLUDED_VALUE } from './response-headers.ts';
import type { GatewayCtx } from '../../shared/gateway-ctx.ts';
import { type StreamCompletion, writeSSEFrames } from '../../shared/sse.ts';
import { recordFailedRequest } from '../../shared/telemetry/performance.ts';
import { settle } from '../../shared/telemetry/settle.ts';
import { tokenUsageFromBillableUsage } from '../../shared/telemetry/usage.ts';
import { forwardUpstreamHeaders, mergeForwardedUpstreamHeaders } from '../../shared/upstream-response.ts';
import { SourceStreamState, eventResultMetadata, plainResultToResponse } from '../shared/respond.ts';
import { doneFrame, eventFrame, isJsonObject, type ProtocolFrame, sseCommentFrame, sseFrame } from '@floway-dev/protocols/common';
import { openaiResponsesProtocolFrameToSSEFrame, OPENAI_RESPONSES_MISSING_TERMINAL_MESSAGE, collectOpenAIResponsesProtocolEventsToResult } from '@floway-dev/protocols/openai-responses';
import { isOpenAIResponsesErrorEvent, isOpenAIResponsesTerminalEvent, type CanonicalOpenAIResponsesPayload, type ClientResponseResource, type ClientOpenAIResponsesStreamEvent, type OpenAIResponsesStreamEventEx, type OpenAIResponsesErrorEx } from '@floway-dev/protocols/openai-responses';
import { type ExecuteResult, type PlainResult, type InternalDebugError, internalDebugErrorFields, toInternalDebugError } from '@floway-dev/provider';
import { apiErrorToResponse } from '@floway-dev/provider';

// Renders an OpenAI Responses failure that never opened a stream. Separate entry
// because a request that fails before its payload parses has no payload to
// answer with, and the events path below requires one.
export const respondOpenAIResponsesFailure = (
  result: Exclude<ExecuteResult<ProtocolFrame<OpenAIResponsesStreamEventEx>>, { type: 'events' }> | PlainResult,
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
    return internalOpenAIResponsesErrorResponse(result.status, result.error);
  }

  if (result.status >= 400) {
    ctx.dump?.error(result.upstreamId !== undefined ? 'upstream' : 'gateway', result.upstreamId);
  }
  return plainResultToResponse(result);
};

// Renders an upstream OpenAI Responses result into the client HTTP/SSE response. An
// events result drains to one JSON body (non-streaming) or is proxied frame by
// frame (streaming); anything else is a pre-stream failure.
export const respondOpenAIResponses = async (
  c: Context,
  result: ExecuteResult<ProtocolFrame<OpenAIResponsesStreamEventEx>> | PlainResult,
  wantsStream: boolean,
  ctx: GatewayCtx,
  request: CanonicalOpenAIResponsesPayload,
): Promise<Response> => {
  if (result.type !== 'events') return respondOpenAIResponsesFailure(result, ctx);

  const state = new SourceStreamState();
  const observed = observeOpenAIResponsesFrames(result.events, state, ctx);
  const frames = wrapOpenAIResponsesClientEgress(observed, ctx, request);

  if (!wantsStream) {
    try {
      const response = await collectOpenAIResponsesProtocolEventsToResult(frames);
      const metadata = await eventResultMetadata(result);
      const usage = tokenUsageFromBillableUsage(metadata.billableUsage);
      ctx.dump?.success(metadata.modelIdentity, usage);
      settle(ctx, metadata.performance, metadata.modelIdentity, usage, state.failed || response.status === 'failed');
      const headers = mergeForwardedUpstreamHeaders(undefined, result.headers);
      headers.set(OPENAI_RESPONSES_REASONING_INCLUDED_HEADER, OPENAI_RESPONSES_REASONING_INCLUDED_VALUE);
      return Response.json(response, { headers });
    } catch (error) {
      ctx.dump?.failed(error);
      if (error instanceof Error && isOpenAIResponsesErrorEvent(error.cause)) {
        const metadata = await eventResultMetadata(result);
        const usage = tokenUsageFromBillableUsage(metadata.billableUsage);
        ctx.dump?.success(metadata.modelIdentity, usage);
        settle(ctx, metadata.performance, metadata.modelIdentity, usage, true);
        const { sequence_number: _sequenceNumber, ...body } = error.cause;
        return Response.json(body, { status: openAIResponsesErrorHttpStatus(error.cause) });
      }
      recordFailedRequest(ctx, result.performance);
      return internalOpenAIResponsesErrorResponse(502, toInternalDebugError(error));
    }
  }

  forwardUpstreamHeaders(c, result.headers);
  c.header(OPENAI_RESPONSES_REASONING_INCLUDED_HEADER, OPENAI_RESPONSES_REASONING_INCLUDED_VALUE);
  const response = streamSSE(c, async stream => {
    let completion: StreamCompletion = 'error';
    try {
      completion = await writeSSEFrames(stream, openaiResponsesSseFrames(frames, state, ctx), {
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

const ERROR_HTTP_STATUS = new Map<string, number>([
  ['invalid_request_error', 400],
  ['invalid_prompt', 400],
  ['authentication_error', 401],
  ['invalid_api_key', 401],
  ['permission_error', 403],
  ['not_found_error', 404],
  ['conflict_error', 409],
  ['unprocessable_entity_error', 422],
  ['rate_limit_error', 429],
  ['rate_limit_exceeded', 429],
  ['insufficient_quota', 429],
  ['server_error', 500],
  ['internal_error', 500],
]);

// OpenAI SDKs classify API failures by these HTTP categories.
// https://github.com/openai/openai-node/blob/b579bcb3e586d22269ffe6fe504653a0e05acbe8/src/core/error.ts#L60-L94
const openAIResponsesErrorHttpStatus = (event: Extract<OpenAIResponsesStreamEventEx, { type: 'error' }>): number => {
  const { type: _type, sequence_number: _sequenceNumber, ...fields } = event;
  const payload = ('error' in fields && isJsonObject(fields.error) ? fields.error : fields) as Readonly<Record<string, unknown>>;
  const details = isJsonObject(payload.provider_specific_fields) ? payload.provider_specific_fields : undefined;
  for (const classification of [payload.code, payload.type, details?.code, details?.type]) {
    if (typeof classification !== 'string') continue;
    const status = ERROR_HTTP_STATUS.get(classification);
    if (status !== undefined) return status;
  }
  return 502;
};

const internalOpenAIResponsesErrorResponse = (status: number, error: InternalDebugError): Response =>
  Response.json({
    error: {
      type: error.type,
      message: error.message,
      provider_specific_fields: internalDebugErrorFields(error),
    },
  }, { status });

// --- frame observation ---

const observeOpenAIResponsesFrames = async function* (frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>>, state: SourceStreamState, ctx: GatewayCtx) {
  for await (const frame of frames) {
    ctx.dump?.frame(frame);
    if (frame.type === 'done') continue;
    const failed = frame.event.type === 'error' || frame.event.type === 'response.failed';
    const terminal = isOpenAIResponsesTerminalEvent(frame.event);
    if (failed) state.failed = true;
    if (terminal && !failed) state.completed = true;
    yield frame;
    if (terminal) return;
  }
  if (state.failed) return;
  throw new Error(OPENAI_RESPONSES_MISSING_TERMINAL_MESSAGE);
};

const openaiResponsesSseFrames = async function* (frames: AsyncIterable<ProtocolFrame<ClientOpenAIResponsesStreamEvent>>, state: SourceStreamState, ctx: GatewayCtx) {
  let announced: ClientResponseResource | undefined;
  try {
    for await (const frame of frames) {
      if (frame.type === 'event' && 'response' in frame.event) announced = frame.event.response;
      yield openaiResponsesProtocolFrameToSSEFrame(frame);
    }
    // The SSE transport terminates on the literal `[DONE]` payload:
    // https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/src/specifications/2026-04-24.mdx?plain=1#L84
    yield openaiResponsesProtocolFrameToSSEFrame(doneFrame());
  } catch (error) {
    state.failed = true;
    const debug = toInternalDebugError(error);
    const failure: OpenAIResponsesErrorEx = { code: debug.type, message: debug.message, provider_specific_fields: internalDebugErrorFields(debug) };
    // SDKs raise on the nested error payload; terminal consumers receive the same diagnostics.
    // https://github.com/openai/openai-node/blob/d77cf24d9f3885739c6cba76bc009abf0ab97428/src/core/streaming.ts#L69-L71
    const errorEvent: ClientOpenAIResponsesStreamEvent = { type: 'error', error: failure };
    ctx.dump?.frame(eventFrame(errorEvent));
    yield sseFrame(JSON.stringify(errorEvent), 'error');
    if (announced !== undefined) {
      // A stream failure also terminates its announced response resource.
      // https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/src/specifications/2026-04-24.mdx#L430
      const failedFrame = eventFrame<ClientOpenAIResponsesStreamEvent>({ type: 'response.failed', response: { ...announced, status: 'failed', error: failure } });
      ctx.dump?.frame(failedFrame);
      yield openaiResponsesProtocolFrameToSSEFrame(failedFrame);
    }
  }
};
