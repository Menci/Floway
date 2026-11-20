import type { Context } from 'hono';

import { wrapOpenAIResponsesClientEgress } from './client-output.ts';
import { OPENAI_RESPONSES_REASONING_INCLUDED_HEADER, OPENAI_RESPONSES_REASONING_INCLUDED_VALUE } from './response-headers.ts';
import type { GatewayCtx } from '../../shared/gateway-ctx.ts';
import { serializeSseFrame, serveSse, type SseProtocol } from '../../shared/sse.ts';
import { recordFailedRequest } from '../../shared/telemetry/performance.ts';
import { settle } from '../../shared/telemetry/settle.ts';
import { tokenUsageFromBillableUsage } from '../../shared/telemetry/usage.ts';
import { forwardBufferedUpstreamResponse } from '../../shared/upstream-response.ts';
import { SourceStreamState, eventResultMetadata, jsonResponseInit, observeChatFrames, settleChatSse } from '../shared/respond.ts';
import { eventFrame, isJsonObject, type ProtocolFrame, sseFrame } from '@floway-dev/protocols/common';
import { openaiResponsesProtocolFrameToSSEFrame, OPENAI_RESPONSES_MISSING_TERMINAL_MESSAGE, collectOpenAIResponsesProtocolEventsToResult } from '@floway-dev/protocols/openai-responses';
import { isOpenAIResponsesErrorEvent, isOpenAIResponsesTerminalEvent, type CanonicalOpenAIResponsesPayload, type ClientResponseResource, type ClientOpenAIResponsesStreamEvent, type OpenAIResponsesStreamEventEx, type OpenAIResponsesErrorEx } from '@floway-dev/protocols/openai-responses';
import { type ExecuteResult, type PlainResult, type InternalDebugError, internalDebugErrorFields, toInternalDebugError } from '@floway-dev/provider';

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
    return forwardBufferedUpstreamResponse(result);
  }

  if (result.type === 'internal-error') {
    recordFailedRequest(ctx, result.performance);
    ctx.dump?.failed(result.error.message);
    return internalOpenAIResponsesErrorResponse(result.http, result.error);
  }

  if (result.http.status >= 400) {
    ctx.dump?.error(result.upstreamId !== undefined ? 'upstream' : 'gateway', result.upstreamId);
  }
  return forwardBufferedUpstreamResponse(result);
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

  if (!wantsStream) {
    const state = new SourceStreamState();
    const frames = wrapOpenAIResponsesClientEgress(observeOpenAIResponsesFrames(result.events, state, ctx), ctx, request);
    try {
      const response = await collectOpenAIResponsesProtocolEventsToResult(frames);
      const metadata = await eventResultMetadata(result);
      const usage = tokenUsageFromBillableUsage(metadata.billableUsage);
      ctx.dump?.success(metadata.modelIdentity, usage);
      settle(ctx, metadata.performance, metadata.modelIdentity, usage, state.failed || response.status === 'failed');
      const init = jsonResponseInit(result.http);
      init.headers.set(OPENAI_RESPONSES_REASONING_INCLUDED_HEADER, OPENAI_RESPONSES_REASONING_INCLUDED_VALUE);
      return Response.json(response, init);
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
      return internalOpenAIResponsesErrorResponse({ status: 502 }, toInternalDebugError(error));
    }
  }

  const headers = new Headers(result.http?.headers);
  headers.set(OPENAI_RESPONSES_REASONING_INCLUDED_HEADER, OPENAI_RESPONSES_REASONING_INCLUDED_VALUE);
  return serveSse(c, {
    http: { status: result.http?.status ?? 200, headers },
    events: wrapOpenAIResponsesClientEgress(observeChatFrames(result.events, ctx), ctx, request),
    downstreamAbortController: ctx.downstreamAbortController,
    protocol: openaiResponsesSseProtocol(ctx),
    settle: outcome => settleChatSse(ctx, result, outcome),
  });
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

const internalOpenAIResponsesErrorResponse = (http: ResponseInit, error: InternalDebugError): Response =>
  Response.json({
    error: {
      type: error.type,
      message: error.message,
      provider_specific_fields: internalDebugErrorFields(error),
    },
  }, http);

// --- frame observation ---

const observeOpenAIResponsesFrames = async function* (frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>>, state: SourceStreamState, ctx: GatewayCtx) {
  for await (const frame of frames) {
    await ctx.dump?.frame(frame);
    if (frame.type === 'done') continue;
    const failed = frame.event.type === 'error' || frame.event.type === 'response.failed';
    if (failed) state.failed = true;
    yield frame;
    if (isOpenAIResponsesTerminalEvent(frame.event)) return;
  }
  if (state.failed) return;
  throw new Error(OPENAI_RESPONSES_MISSING_TERMINAL_MESSAGE);
};

const openaiResponsesSseProtocol = (ctx: GatewayCtx): SseProtocol<ProtocolFrame<ClientOpenAIResponsesStreamEvent>> => {
  let announced: ClientResponseResource | undefined;
  let upstreamFailure: OpenAIResponsesErrorEx | undefined;
  let nextSequence = 0;
  const completedItems = new Map<number, ClientResponseResource['output'][number]>();
  // https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/src/specifications/2026-04-24.mdx#L82-L86
  const done = serializeSseFrame(sseFrame('[DONE]'));
  const emit = async (event: ClientOpenAIResponsesStreamEvent) => {
    const frame = eventFrame(event);
    const wire = serializeSseFrame(openaiResponsesProtocolFrameToSSEFrame(frame));
    await ctx.dump?.frame(frame);
    return wire;
  };
  const failedTrailer = async (failure: OpenAIResponsesErrorEx) => {
    if (announced === undefined) return [done] as const;
    // https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/src/specifications/2026-04-24.mdx#L419-L444
    const output = [...completedItems].sort(([left], [right]) => left - right).map(([, item]) => item);
    return [await emit({
      type: 'response.failed',
      sequence_number: nextSequence++,
      response: { ...announced, status: 'failed', output, incomplete_details: null, error: failure },
    }), done] as const;
  };
  const eof: SseProtocol<ProtocolFrame<ClientOpenAIResponsesStreamEvent>>['eof'] = async () => upstreamFailure
    ? { type: 'protocol-error', trailer: await failedTrailer(upstreamFailure) }
    : { type: 'premature-eof', error: new Error(OPENAI_RESPONSES_MISSING_TERMINAL_MESSAGE) };

  return {
    encode: async frame => {
      if (frame.type === 'done') return { wire: null, end: await eof() };
      const event = { ...frame.event, sequence_number: frame.event.sequence_number ?? nextSequence };
      const wire = serializeSseFrame(openaiResponsesProtocolFrameToSSEFrame(eventFrame(event)));
      nextSequence = Math.max(nextSequence, event.sequence_number + 1);
      if ('response' in event) announced = event.response;
      if (event.type === 'response.output_item.done') completedItems.set(event.output_index, event.item);
      if (isOpenAIResponsesErrorEvent(event)) {
        const { type: _type, sequence_number: _sequence, ...fields } = event;
        const error = 'error' in fields ? fields.error : fields;
        // The stream error permits a null code; a failed Response requires a code.
        // https://github.com/openai/openai-node/blob/d77cf24d9f3885739c6cba76bc009abf0ab97428/src/resources/responses/responses.ts
        upstreamFailure = { ...error, code: error.code ?? 'server_error' };
      }
      return isOpenAIResponsesTerminalEvent(event)
        ? { wire, end: { type: event.type === 'response.failed' || upstreamFailure ? 'protocol-error' : 'completed', trailer: [done] } }
        : { wire };
    },
    eof,
    failure: async error => {
      if (upstreamFailure) return await failedTrailer(upstreamFailure);
      const debug = toInternalDebugError(error);
      const failure: OpenAIResponsesErrorEx = { code: debug.type, message: debug.message, provider_specific_fields: internalDebugErrorFields(debug) };
      // SDKs raise on the nested payload; the Responses event also has native top-level fields.
      // https://github.com/openai/openai-node/blob/d77cf24d9f3885739c6cba76bc009abf0ab97428/src/core/streaming.ts#L69-L71
      return [await emit({
        type: 'error', sequence_number: nextSequence++,
        code: failure.code, message: failure.message, param: null, error: failure,
      }), ...await failedTrailer(failure)];
    },
  };
};
