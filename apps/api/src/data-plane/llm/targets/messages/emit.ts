import { messagesBaseInterceptors } from './interceptors/index.ts';
import type { TelemetryModelIdentity } from '../../../../repo/types.ts';
import { type MessagesInvocation, type RequestContext, runInterceptors } from '../../interceptors.ts';
import { eventResult, type ExecuteResult } from '../../shared/errors/result.ts';
import { targetInternalError, targetModelIdentity, targetProviderResultToFrames } from '../emit.ts';
import { parseTargetStreamFrames } from '../events/from-stream.ts';
import { doneFrame, eventFrame, type ProtocolFrame, type SseFrame } from '@floway-dev/protocols/common';
import type { MessagesPayload, MessagesStreamEventData } from '@floway-dev/protocols/messages';

const targetApi = 'messages';

export const messagesStreamFramesToEvents = (frames: AsyncIterable<SseFrame>): AsyncGenerator<ProtocolFrame<MessagesStreamEventData>> =>
  (async function* () {
    for await (const frame of parseTargetStreamFrames<MessagesStreamEventData>(frames, {
      protocol: 'Messages',
      malformedJsonEventName: 'message',
    })) {
      if (frame.type === 'done') {
        yield doneFrame();
      } else {
        yield eventFrame(frame.data);
      }
    }
  })();

export const emitToMessages = async (invocation: MessagesInvocation, request: RequestContext): Promise<ExecuteResult<ProtocolFrame<MessagesStreamEventData>>> => {
  let modelIdentity: TelemetryModelIdentity | undefined;

  try {
    return await runInterceptors(invocation, request, [...messagesBaseInterceptors, ...(invocation.targetInterceptors?.messages ?? [])], async () => {
      const upstreamStartedAt = performance.now();
      const { model: _model, ...body }: MessagesPayload = invocation.payload;
      const providerResult = await invocation.provider.callMessages(invocation.upstreamModel, body, request.downstreamAbortSignal, invocation.headers, invocation.anthropicBeta);
      modelIdentity = targetModelIdentity(invocation, providerResult.modelKey);
      const result = await targetProviderResultToFrames(invocation, request, targetApi, providerResult, modelIdentity, upstreamStartedAt);

      return result.type === 'events' ? eventResult(messagesStreamFramesToEvents(result.events), result.modelIdentity, result.performance, result.finalMetadata) : result;
    });
  } catch (error) {
    return targetInternalError(invocation, request, targetApi, error, modelIdentity);
  }
};
