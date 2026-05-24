import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';

import { CHAT_COMPLETIONS_MISSING_DONE_MESSAGE } from './events/protocol.ts';
import { collectChatProtocolEventsToCompletion } from './events/reassemble.ts';
import { chatProtocolFrameToSSEFrame } from './events/to-sse.ts';
import { tokenUsage } from '../../../shared/telemetry/usage.ts';
import type { RequestContext } from '../../interceptors.ts';
import { type InternalDebugError, toInternalDebugError } from '../../shared/errors/internal-debug-error.ts';
import type { ExecuteResult } from '../../shared/errors/result.ts';
import { upstreamErrorToResponse } from '../../shared/errors/upstream-error.ts';
import { type StreamCompletion, writeSSEFrames } from '../../shared/stream/proxy-sse.ts';
import { createSourceStreamState, eventResultMetadata, recordSourcePerformance, recordSourceUsage, rememberSourceFrameUsage, sourceStreamFailed } from '../respond.ts';
import type { ChatCompletionChunk, ChatCompletionResponse } from '@floway-dev/protocols/chat-completions';
import { chatCompletionsErrorPayloadMessage } from '@floway-dev/protocols/chat-completions';
import { type ProtocolFrame, sseCommentFrame, sseFrame } from '@floway-dev/protocols/common';

type CC = ChatCompletionChunk;
type CU = NonNullable<ChatCompletionResponse['usage']>;

export const tokenUsageFromChatUsage = (u: CU) => {
  const read = u.prompt_tokens_details?.cached_tokens ?? 0;
  return tokenUsage(u.prompt_tokens, u.completion_tokens, read);
};

export const tokenUsageFromChatFrame = (f: ProtocolFrame<CC>) =>
  f.type === 'event' && Array.isArray(f.event.choices) && f.event.choices.length === 0 && f.event.usage ? tokenUsageFromChatUsage(f.event.usage) : null;

const internalChatErrorPayload = (error: InternalDebugError) => ({
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

const internalChatErrorResponse = (status: number, error: InternalDebugError): Response => Response.json(internalChatErrorPayload(error), { status });

const internalChatStreamErrorFrame = (error: unknown) => sseFrame(JSON.stringify(internalChatErrorPayload(toInternalDebugError(error, 'chat-completions'))), 'error');

const isChatFailureFrame = (frame: ProtocolFrame<ChatCompletionChunk>) => frame.type === 'event' && chatCompletionsErrorPayloadMessage(frame.event) !== null;

const chatTerminalFrame = (frame: ProtocolFrame<ChatCompletionChunk>) => frame.type === 'done' || isChatFailureFrame(frame);

const observeChatFrames = async function* (frames: AsyncIterable<ProtocolFrame<ChatCompletionChunk>>, state: ReturnType<typeof createSourceStreamState>, observeUsage: boolean) {
  for await (const frame of frames) {
    const failed = isChatFailureFrame(frame);
    if (failed) state.failed = true;
    if (frame.type === 'done' || observeUsage) {
      rememberSourceFrameUsage(state, tokenUsageFromChatFrame(frame));
    }
    if (chatTerminalFrame(frame) && !failed) state.completed = true;
    yield frame;
    if (chatTerminalFrame(frame)) return;
  }
  throw new Error(CHAT_COMPLETIONS_MISSING_DONE_MESSAGE);
};

const chatSseFrames = async function* (frames: AsyncIterable<ProtocolFrame<ChatCompletionChunk>>, includeUsageChunk: boolean, state: ReturnType<typeof createSourceStreamState>) {
  try {
    for await (const frame of frames) {
      const sse = chatProtocolFrameToSSEFrame(frame, { includeUsageChunk });
      if (sse) yield sse;
    }
  } catch (error) {
    state.failed = true;
    yield internalChatStreamErrorFrame(error);
  }
};

export const respondChatCompletions = async (
  c: Context,
  result: ExecuteResult<ProtocolFrame<ChatCompletionChunk>>,
  wantsStream: boolean,
  includeUsageChunk: boolean,
  request: RequestContext,
  downstreamAbortController: AbortController | undefined,
): Promise<Response> => {
  if (result.type === 'upstream-error') {
    recordSourcePerformance(request, result.performance, true);
    return upstreamErrorToResponse(result);
  }

  if (result.type === 'internal-error') {
    recordSourcePerformance(request, result.performance, true);
    return internalChatErrorResponse(result.status, result.error);
  }

  const state = createSourceStreamState();
  const frames = observeChatFrames(result.events, state, wantsStream);

  if (!wantsStream) {
    try {
      const response = await collectChatProtocolEventsToCompletion(frames);
      const metadata = await eventResultMetadata(result);
      const usage = response.usage ? tokenUsageFromChatUsage(response.usage) : null;
      await recordSourceUsage(request, metadata.modelIdentity, usage);
      recordSourcePerformance(request, metadata.performance, state.failed);
      return Response.json(response);
    } catch (error) {
      recordSourcePerformance(request, result.performance, true);
      return internalChatErrorResponse(502, toInternalDebugError(error, 'chat-completions'));
    }
  }

  return streamSSE(c, async stream => {
    let completion: StreamCompletion = 'error';
    try {
      completion = await writeSSEFrames(stream, chatSseFrames(frames, includeUsageChunk, state), {
        keepAlive: { frame: sseCommentFrame('keepalive') },
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
