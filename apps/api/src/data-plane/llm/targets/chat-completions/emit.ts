import { chatCompletionsBaseInterceptors } from './interceptors/index.ts';
import type { TelemetryModelIdentity } from '../../../../repo/types.ts';
import { type ChatCompletionsInvocation, type RequestContext, runInterceptors } from '../../interceptors.ts';
import { eventResult, type ExecuteResult } from '../../shared/errors/result.ts';
import { targetInternalError, targetModelIdentity, targetProviderResultToFrames } from '../emit.ts';
import { parseTargetStreamFrames } from '../events/from-stream.ts';
import type { ChatCompletionChunk, ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import { chatCompletionsErrorPayloadMessage } from '@floway-dev/protocols/chat-completions';
import { doneFrame, eventFrame, type ProtocolFrame, type SseFrame } from '@floway-dev/protocols/common';

const targetApi = 'chat-completions';

// Probes for OpenAI-style streamed error payloads before the unknown body is
// committed to the ChatCompletionChunk shape. Receives unknown (not the
// generic `ChatCompletionChunk`) because the inspection runs on the raw
// upstream JSON.
const guardChatCompletionsError = (parsed: unknown): void => {
  const errorMessage = chatCompletionsErrorPayloadMessage(parsed);
  if (errorMessage) {
    throw new Error(`Upstream Chat Completions SSE error: ${errorMessage}`);
  }
};

export const chatCompletionsStreamFramesToEvents = (frames: AsyncIterable<SseFrame>): AsyncGenerator<ProtocolFrame<ChatCompletionChunk>> =>
  (async function* () {
    for await (const frame of parseTargetStreamFrames<ChatCompletionChunk>(frames, {
      protocol: 'Chat Completions',
    })) {
      if (frame.type === 'done') {
        yield doneFrame();
      } else {
        guardChatCompletionsError(frame.data);
        yield eventFrame(frame.data);
      }
    }
  })();

export const emitToChatCompletions = async (invocation: ChatCompletionsInvocation, request: RequestContext): Promise<ExecuteResult<ProtocolFrame<ChatCompletionChunk>>> => {
  let modelIdentity: TelemetryModelIdentity | undefined;

  try {
    return await runInterceptors(invocation, request, [...chatCompletionsBaseInterceptors, ...(invocation.targetInterceptors?.chatCompletions ?? [])], async () => {
      const upstreamStartedAt = performance.now();
      const { model: _model, ...body }: ChatCompletionsPayload = invocation.payload;
      const providerResult = await invocation.provider.callChatCompletions(invocation.upstreamModel, body, request.downstreamAbortSignal, invocation.headers);
      modelIdentity = targetModelIdentity(invocation, providerResult.modelKey);
      const result = await targetProviderResultToFrames(invocation, request, targetApi, providerResult, modelIdentity, upstreamStartedAt);

      return result.type === 'events' ? eventResult(chatCompletionsStreamFramesToEvents(result.events), result.modelIdentity, result.performance, result.finalMetadata) : result;
    });
  } catch (error) {
    return targetInternalError(invocation, request, targetApi, error, modelIdentity);
  }
};
