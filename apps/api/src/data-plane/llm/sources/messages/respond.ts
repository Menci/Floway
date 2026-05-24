import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';

import { MESSAGES_MISSING_TERMINAL_MESSAGE, collectMessagesProtocolEventsToResponse } from './events/to-response.ts';
import { messagesProtocolFrameToSSEFrame } from './events/to-sse.ts';
import { tokenUsage } from '../../../shared/telemetry/usage.ts';
import type { RequestContext } from '../../interceptors.ts';
import { type InternalDebugError, toInternalDebugError } from '../../shared/errors/internal-debug-error.ts';
import type { ExecuteResult } from '../../shared/errors/result.ts';
import { upstreamErrorToResponse } from '../../shared/errors/upstream-error.ts';
import { type StreamCompletion, writeSSEFrames } from '../../shared/stream/proxy-sse.ts';
import { createSourceStreamState, eventResultMetadata, recordSourcePerformance, recordSourceUsage, rememberSourceFrameUsage, sourceStreamFailed } from '../respond.ts';
import { type ProtocolFrame, sseFrame } from '@floway-dev/protocols/common';
import type { MessagesMessageDeltaEvent, MessagesStreamEventData, MessagesUsage } from '@floway-dev/protocols/messages';

type MU = MessagesUsage | NonNullable<MessagesMessageDeltaEvent['usage']>;

export const tokenUsageFromMessagesUsage = (u: MU) => {
  const read = u.cache_read_input_tokens ?? 0;
  const created = u.cache_creation_input_tokens ?? 0;
  return tokenUsage((u.input_tokens ?? 0) + read + created, u.output_tokens, read, created);
};

export const createMessagesStreamUsageState = () => ({
  current: tokenUsage(),
  gotInputFromStart: false,
});

type MessagesStreamUsageState = ReturnType<typeof createMessagesStreamUsageState>;
const mergeMessagesUsage = (state: MessagesStreamUsageState, u: MU) => Object.assign(state.current, tokenUsageFromMessagesUsage(u));

export const tokenUsageFromMessagesFrame = (frame: ProtocolFrame<MessagesStreamEventData>, state: MessagesStreamUsageState) => {
  if (frame.type !== 'event') return null;
  const { event } = frame;
  if (event.type === 'message_start') {
    const usage = mergeMessagesUsage(state, event.message.usage);
    state.gotInputFromStart ||= usage.inputTokens > 0;
  }
  if (event.type === 'message_delta' && event.usage) {
    if (!state.gotInputFromStart && event.usage.input_tokens !== undefined) {
      mergeMessagesUsage(state, event.usage);
    } else state.current.outputTokens = event.usage.output_tokens;
  }
  return event.type === 'message_stop' ? state.current : null;
};

const internalMessagesErrorPayload = (error: InternalDebugError) => ({
  type: 'error',
  error: {
    type: error.type,
    name: error.name,
    message: error.message,
    stack: error.stack,
    cause: error.cause,
    source_api: error.source_api,
    target_api: error.target_api,
  },
});

const downstreamMessagesPingKeepAliveFrame = sseFrame(JSON.stringify({ type: 'ping' }), 'ping');

const internalMessagesErrorResponse = (status: number, error: InternalDebugError): Response => Response.json(internalMessagesErrorPayload(error), { status });

const internalMessagesStreamErrorFrame = (error: unknown) => sseFrame(JSON.stringify(internalMessagesErrorPayload(toInternalDebugError(error, 'messages'))), 'error');

const isMessagesFailureFrame = (frame: ProtocolFrame<MessagesStreamEventData>) => frame.type === 'event' && frame.event.type === 'error';

const isMessagesTerminalFrame = (frame: ProtocolFrame<MessagesStreamEventData>) => frame.type === 'event' && (frame.event.type === 'message_stop' || frame.event.type === 'error');

const observeMessagesFrames = async function* (
  frames: AsyncIterable<ProtocolFrame<MessagesStreamEventData>>,
  state: ReturnType<typeof createSourceStreamState>,
  usageState: ReturnType<typeof createMessagesStreamUsageState>,
  observeUsage: boolean,
) {
  for await (const frame of frames) {
    const failed = isMessagesFailureFrame(frame);
    if (failed) state.failed = true;
    if (observeUsage) {
      rememberSourceFrameUsage(state, tokenUsageFromMessagesFrame(frame, usageState));
    }
    if (isMessagesTerminalFrame(frame) && !failed) state.completed = true;
    yield frame;
    if (isMessagesTerminalFrame(frame)) return;
  }
  throw new Error(MESSAGES_MISSING_TERMINAL_MESSAGE);
};

const messagesSseFrames = async function* (frames: AsyncIterable<ProtocolFrame<MessagesStreamEventData>>, state: ReturnType<typeof createSourceStreamState>) {
  try {
    for await (const frame of frames) {
      const sse = messagesProtocolFrameToSSEFrame(frame);
      if (sse) yield sse;
    }
  } catch (error) {
    state.failed = true;
    yield internalMessagesStreamErrorFrame(error);
  }
};

export const respondMessages = async (
  c: Context,
  result: ExecuteResult<ProtocolFrame<MessagesStreamEventData>>,
  wantsStream: boolean,
  request: RequestContext,
  downstreamAbortController: AbortController | undefined,
): Promise<Response> => {
  if (result.type === 'upstream-error') {
    recordSourcePerformance(request, result.performance, true);
    return upstreamErrorToResponse(result);
  }

  if (result.type === 'internal-error') {
    recordSourcePerformance(request, result.performance, true);
    return internalMessagesErrorResponse(result.status, result.error);
  }

  const state = createSourceStreamState();
  const usageState = createMessagesStreamUsageState();
  const frames = observeMessagesFrames(result.events, state, usageState, wantsStream);

  if (!wantsStream) {
    try {
      const response = await collectMessagesProtocolEventsToResponse(frames);
      const metadata = await eventResultMetadata(result);
      await recordSourceUsage(request, metadata.modelIdentity, tokenUsageFromMessagesUsage(response.usage));
      recordSourcePerformance(request, metadata.performance, state.failed);
      return Response.json(response);
    } catch (error) {
      recordSourcePerformance(request, result.performance, true);
      return internalMessagesErrorResponse(502, toInternalDebugError(error, 'messages'));
    }
  }

  return streamSSE(c, async stream => {
    let completion: StreamCompletion = 'error';
    try {
      completion = await writeSSEFrames(stream, messagesSseFrames(frames, state), {
        keepAlive: { frame: downstreamMessagesPingKeepAliveFrame },
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
