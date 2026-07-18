import type { Context } from 'hono';

import { wrapMessagesAffinityEgress } from './affinity/egress.ts';
import { recordFailedRequest } from '../../shared/telemetry/performance.ts';
import { settle } from '../../shared/telemetry/settle.ts';
import { tokenUsage } from '../../shared/telemetry/usage.ts';
import { affinityEgressOptions } from '../shared/affinity/index.ts';
import type { GatewayCtx } from '../shared/gateway-ctx.ts';
import { SourceStreamState, eventResultMetadata, mergeForwardedUpstreamHeaders, plainResultToResponse, respondSseStream } from '../shared/respond.ts';
import { billableServiceTier, type ProtocolFrame, sseFrame } from '@floway-dev/protocols/common';
import { messagesProtocolFrameToSSEFrame, MESSAGES_MISSING_TERMINAL_MESSAGE, collectMessagesProtocolEventsToResult, mergeMessagesUsageSnapshot, messagesUsageSnapshot, splitMessagesCacheCreationTokens } from '@floway-dev/protocols/messages';
import type { MessagesMessageDeltaEvent, MessagesStreamEvent, MessagesUsage } from '@floway-dev/protocols/messages';
import { type ExecuteResult, type PlainResult, type InternalDebugError, toInternalDebugError } from '@floway-dev/provider';
import { apiErrorToResponse } from '@floway-dev/provider';

type MessagesUsageLike = MessagesUsage | NonNullable<MessagesMessageDeltaEvent['usage']>;

// Renders an upstream Messages result into the client HTTP/SSE response. An
// error-typed result is a pre-stream failure and always answers as HTTP; an
// events result drains to one JSON body (non-streaming) or is proxied frame by
// frame (streaming). `success` reports whether a non-streaming body was
// produced, so the orchestrator knows whether to flush stored items.
export const respondMessages = async (
  c: Context,
  result: ExecuteResult<ProtocolFrame<MessagesStreamEvent>> | PlainResult,
  wantsStream: boolean,
  ctx: GatewayCtx,
): Promise<{ success: boolean; response: Response }> => {
  if (result.type === 'api-error') {
    recordFailedRequest(ctx, result.performance);
    ctx.dump?.error(result.source, result.upstream);
    return { success: false, response: apiErrorToResponse(result) };
  }

  if (result.type === 'internal-error') {
    recordFailedRequest(ctx, result.performance);
    ctx.dump?.failed(result.error.message);
    return { success: false, response: internalMessagesErrorResponse(result.status, result.error) };
  }

  if (result.type === 'plain') {
    if (result.status >= 400) {
      ctx.dump?.error(result.upstream !== undefined ? 'upstream' : 'gateway', result.upstream);
    }
    return { success: true, response: plainResultToResponse(result) };
  }

  const state = new SourceStreamState();
  const usageState = createMessagesStreamUsageState();
  const observed = observeMessagesFrames(result.events, state, usageState, wantsStream, ctx);
  const frames = wrapMessagesAffinityEgress(observed, affinityEgressOptions(ctx));

  if (!wantsStream) {
    try {
      const response = await collectMessagesProtocolEventsToResult(frames);
      const metadata = await eventResultMetadata(result);
      const usage = tokenUsageFromMessagesUsage(response.usage);
      ctx.dump?.success(metadata.modelIdentity, usage);
      settle(ctx, metadata.performance, metadata.modelIdentity, usage, state.failed);
      return { success: true, response: Response.json(response, { headers: mergeForwardedUpstreamHeaders(undefined, result.headers) }) };
    } catch (error) {
      recordFailedRequest(ctx, result.performance);
      ctx.dump?.failed(error);
      return { success: false, response: internalMessagesErrorResponse(502, toInternalDebugError(error)) };
    }
  }

  const response = respondSseStream(c, result, state, ctx, {
    sseFrames: messagesSseFrames(frames, state),
    keepAliveFrame: sseFrame(JSON.stringify({ type: 'ping' }), 'ping'),
    protocolTag: 'messages',
  });

  return { success: true, response };
};

// Anthropic already reports disjoint token counts: input_tokens excludes the
// cache figures. Map them straight onto the billing dimensions without
// summing. When the upstream emits the `cache_creation` sub-object
// (extended-cache-ttl-2025-04-11), split the per-TTL counts onto the 5m and
// 1h dimensions; the flat `cache_creation_input_tokens` is the sum and is
// only consulted when the sub-object is absent.
//
// Response usage carries two server-stamped tier fields: `speed` (fast mode)
// and `service_tier` (capacity assignment). Fast mode is documented as
// unavailable with Priority Tier and the Batch API, so at most one
// non-`standard` value lands on a single response — prefer `speed` first
// (the only multi-x override today) then fall through to `service_tier`.
// `standard` on either side collapses to null so per-tier rows aggregate
// with base; unknown values flow through verbatim so a future Anthropic
// release does not silently bill at base.
//   * https://docs.claude.com/en/build-with-claude/fast-mode
//   * https://docs.claude.com/en/api/service-tiers
const tokenUsageFromMessagesUsage = (u: MessagesUsageLike) => {
  const { cacheWrite, cacheWrite1h } = splitMessagesCacheCreationTokens(u);
  const tier = billableServiceTier(u.speed) ?? billableServiceTier(u.service_tier);
  return tokenUsage({
    input: u.input_tokens ?? 0,
    input_cache_read: u.cache_read_input_tokens ?? 0,
    input_cache_write: cacheWrite,
    input_cache_write_1h: cacheWrite1h,
    output: u.output_tokens,
    tier,
  });
};

export const createMessagesStreamUsageState = () => ({
  raw: messagesUsageSnapshot(),
  current: tokenUsage({}),
});

type MessagesStreamUsageState = ReturnType<typeof createMessagesStreamUsageState>;

// Returns a snapshot of the running usage on every frame that revises it, not
// only on `message_stop`, so the respond layer can checkpoint billing state
// into `SourceStreamState.usage` as the stream progresses. A client disconnect
// that races the terminal frame would otherwise discard the last
// `message_delta`'s output count. Each call returns a fresh object so the
// snapshot stored in `SourceStreamState.usage` does not silently mutate when
// the next delta lands.
export const tokenUsageFromMessagesFrame = (frame: ProtocolFrame<MessagesStreamEvent>, state: MessagesStreamUsageState) => {
  if (frame.type !== 'event') return null;
  const { event } = frame;
  if (event.type === 'message_start') {
    state.raw = messagesUsageSnapshot(event.message.usage);
    state.current = tokenUsageFromMessagesUsage(state.raw);
    return { ...state.current };
  }
  if (event.type === 'message_delta' && event.usage) {
    state.raw = mergeMessagesUsageSnapshot(state.raw, event.usage);
    state.current = tokenUsageFromMessagesUsage(state.raw);
    return { ...state.current };
  }
  return event.type === 'message_stop' ? { ...state.current } : null;
};

const internalMessagesErrorPayload = (error: InternalDebugError) => ({
  type: 'error',
  error: {
    type: error.type,
    name: error.name,
    message: error.message,
    stack: error.stack,
    cause: error.cause,
    target_api: error.target_api,
  },
});

const internalMessagesErrorResponse = (status: number, error: InternalDebugError): Response => Response.json(internalMessagesErrorPayload(error), { status });

const isMessagesTerminalFrame = (frame: ProtocolFrame<MessagesStreamEvent>) => frame.type === 'event' && (frame.event.type === 'message_stop' || frame.event.type === 'error');

const observeMessagesFrames = async function* (
  frames: AsyncIterable<ProtocolFrame<MessagesStreamEvent>>,
  state: SourceStreamState,
  usageState: MessagesStreamUsageState,
  observeUsage: boolean,
  ctx: GatewayCtx,
) {
  for await (const frame of frames) {
    ctx.dump?.frame(frame);
    const failed = frame.type === 'event' && frame.event.type === 'error';
    if (failed) state.failed = true;
    if (observeUsage) {
      state.rememberUsage(tokenUsageFromMessagesFrame(frame, usageState));
    }
    if (isMessagesTerminalFrame(frame) && !failed) state.completed = true;
    yield frame;
    if (isMessagesTerminalFrame(frame)) return;
  }
  throw new Error(MESSAGES_MISSING_TERMINAL_MESSAGE);
};

const messagesSseFrames = async function* (frames: AsyncIterable<ProtocolFrame<MessagesStreamEvent>>, state: SourceStreamState) {
  try {
    for await (const frame of frames) {
      const sse = messagesProtocolFrameToSSEFrame(frame);
      if (sse) yield sse;
    }
  } catch (error) {
    state.failed = true;
    yield sseFrame(JSON.stringify(internalMessagesErrorPayload(toInternalDebugError(error))), 'error');
  }
};
