import { wrapOpenAIChatCompletionsAffinityEgress } from './affinity/egress.ts';
import type { Fields } from './facts.ts';
import { isFailure, renderFailure, mintedErrorEnvelope } from '../../pipeline/facts.ts';
import { isForwardableUpstreamHeader } from '../../shared/upstream-response.ts';
import type { ChatServices } from '../services.ts';
import { affinityEgressOptions } from '../shared/affinity/index.ts';
import { bindClientRelease, collectClientFrames, framedClientStream, withClientVerdict } from '../shared/client-stream.ts';
import { recordStream } from '@floway-dev/dump';
import { defineStage, move } from '@floway-dev/pipeline';
import { eventFrame, isOpenAIUsageOnlyEventShape, type ProtocolFrame } from '@floway-dev/protocols/common';
import { collectOpenAIChatCompletionsProtocolEventsToResult, openaiChatCompletionsProtocolFrameToSSEFrame, type OpenAIChatCompletionsStreamEvent, type ClientOpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import { toInternalDebugError } from '@floway-dev/provider';

/**
 * The outermost edge. A chat answer is always a stream by the time it reaches here — the
 * upstream speaks SSE whatever the client asked for — so what this decides is whether the
 * client sees the frames or the one object they add up to.
 *
 * Collecting is therefore the edge's own work and not a second reading of the upstream: the
 * same frames that would have gone out are folded here instead.
 */
export const emitOpenAIChatCompletions = defineStage<
  Fields<'ingress.chat.openaiChatCompletions.wantsStream' | 'ingress.chat.openaiChatCompletions.wantsUsageChunk'>,
  Fields<'ingress.chat.openaiChatCompletions.wantsStream' | 'ingress.chat.openaiChatCompletions.wantsUsageChunk'>,
  Fields<'ingress.chat.openaiChatCompletions.wantsStream' | 'ingress.chat.openaiChatCompletions.wantsUsageChunk'
    | 'response.chat.openaiChatCompletions' | 'response.http.headers' | 'response.http.status' | 'response.chat.openaiChatCompletions.streamedUsage'>,
  Fields<'response.chat.openaiChatCompletions.rendered' | 'response.http.status' | 'response.http.headers' | 'response.chat.clientFrames' | 'response.chat.openaiChatCompletions.streamedUsage'>,
  ChatServices
>({
  name: 'emitOpenAIChatCompletions',
  through: {
    request: {
      needs: ['ingress.chat.openaiChatCompletions.wantsStream', 'ingress.chat.openaiChatCompletions.wantsUsageChunk'],
      consumes: [],
      provides: [],
    },
    response: {
      needs: ['response.chat.openaiChatCompletions', 'response.http.headers', 'response.http.status', 'response.chat.openaiChatCompletions.streamedUsage'],
      consumes: ['response.chat.openaiChatCompletions', 'response.http.headers'],
      provides: ['response.chat.clientFrames', 'response.chat.openaiChatCompletions.rendered', 'response.http.status', 'response.http.headers', 'response.chat.openaiChatCompletions.streamedUsage'],
    },
  },
  execute: async (facts, next, use) => {
    const back = await next(facts);
    const { 'response.chat.openaiChatCompletions': answer, 'response.http.headers': headers, ...rest } = back;
    // Vendor traces and quota state stay visible; what an intermediary must strip, and what
    // would misdescribe a body this gateway serialized itself, does not. A filter that removed
    // nothing hands the same array on, so the record shows no change where none happened.
    const forwardable = headers.filter(([name]) => isForwardableUpstreamHeader(name));
    const forClient = forwardable.length === headers.length ? headers : move(forwardable);

    if (isFailure(answer)) {
      const failure = renderFailure(answer, mintedErrorEnvelope);
      return {
        ...rest,
        'response.chat.clientFrames': null,
        'response.http.headers': forClient,
        'response.chat.openaiChatCompletions.rendered': move(failure.body),
        'response.http.status': failure.status,
      };
    }
    if (answer.kind === 'value') {
      return {
        ...rest,
        'response.chat.clientFrames': null,
        'response.http.headers': forClient,
        'response.chat.openaiChatCompletions.rendered': move(answer.body as Record<string, unknown>),
        'response.http.status': back['response.http.status'],
      };
    }

    // The turn's own state, written back into the frames the client is handed: a follow-up
    // carrying it comes back to the upstream that issued it. This is the other half of the
    // affinity the resolver read on the way down, and it has to sit here because it rewrites
    // the frames — below the fold, and there would be nothing left to rewrite.
    const egress = wrapOpenAIChatCompletionsAffinityEgress(
      answer.frames as AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>,
      affinityEgressOptions(use.gateway),
    );
    if (!back['ingress.chat.openaiChatCompletions.wantsStream']) {
      const frames = recordStream(egress, use.gateway.dump);
      return {
        ...rest,
        'response.chat.clientFrames': move(frames),
        'response.http.headers': forClient,
        'response.chat.openaiChatCompletions.rendered': move(
          await collectClientFrames(frames, collectOpenAIChatCompletionsProtocolEventsToResult) as unknown as Record<string, unknown>,
        ),
        'response.http.status': back['response.http.status'],
      };
    }
    const completed = framedClientStream<ProtocolFrame<ClientOpenAIChatCompletionsStreamEvent>>(
      clientFrames(egress, back['ingress.chat.openaiChatCompletions.wantsUsageChunk']),
      frame => openaiChatCompletionsProtocolFrameToSSEFrame(frame, { includeUsageChunk: true }),
      error => [eventFrame({ error: toInternalDebugError(error, 'openaiChatCompletions') })],
      use.gateway.dump,
    );
    bindClientRelease(back, completed.release);
    return {
      ...rest,
      'response.chat.clientFrames': move(completed.frames),
      'response.http.headers': forClient,
      'response.chat.openaiChatCompletions.rendered': move(completed.rendered),
      'response.chat.openaiChatCompletions.streamedUsage': move(withClientVerdict(back['response.chat.openaiChatCompletions.streamedUsage'], completed.failed)),
      'response.http.status': back['response.http.status'],
    };
  },
});

// Metering reads every usage chunk below this edge. A streaming client opts into seeing it,
// so that protocol selection precedes the record of what the client is served.
const clientFrames = (frames: AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>, includeUsageChunk: boolean): AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>> => includeUsageChunk ? frames : ({
  [Symbol.asyncIterator]: () => (async function* () {
    for await (const frame of frames) {
      if (frame.type === 'event' && isOpenAIUsageOnlyEventShape(frame.event)) continue;
      yield frame;
    }
  })(),
});
