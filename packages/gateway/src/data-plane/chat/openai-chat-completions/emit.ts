import { wrapOpenAIChatCompletionsAffinityEgress } from './affinity/egress.ts';
import type { Fields } from './facts.ts';
import { recordStream, streamReferenceOf } from '../../../dump/run-sink.ts';
import { isFailure, renderFailure, mintedErrorEnvelope } from '../../pipeline/facts.ts';
import { isForwardableUpstreamHeader } from '../../shared/upstream-response.ts';
import type { ChatServices } from '../services.ts';
import { affinityEgressOptions } from '../shared/affinity/index.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import type { ProtocolFrame, SseFrame } from '@floway-dev/protocols/common';
import { collectOpenAIChatCompletionsProtocolEventsToResult, openaiChatCompletionsProtocolFrameToSSEFrame, type OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

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
    | 'response.chat.openaiChatCompletions' | 'response.http.headers'>,
  Fields<'response.chat.openaiChatCompletions.rendered' | 'response.http.status' | 'response.http.headers' | 'response.chat.clientFrames'>,
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
      needs: ['response.chat.openaiChatCompletions', 'response.http.headers'],
      consumes: ['response.chat.openaiChatCompletions', 'response.http.headers'],
      provides: ['response.chat.clientFrames', 'response.chat.openaiChatCompletions.rendered', 'response.http.status', 'response.http.headers'],
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
        'response.http.status': 200,
      };
    }

    // The turn's own state, written back into the frames the client is handed: a follow-up
    // carrying it comes back to the upstream that issued it. This is the other half of the
    // affinity the resolver read on the way down, and it has to sit here because it rewrites
    // the frames — below the fold, and there would be nothing left to rewrite.
    const frames = recordStream(
      wrapOpenAIChatCompletionsAffinityEgress(
        answer.frames as AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>,
        affinityEgressOptions(use.gateway),
      ),
      use.gateway.dump,
    );
    if (!back['ingress.chat.openaiChatCompletions.wantsStream']) {
      return {
        ...rest,
        'response.chat.clientFrames': move(frames),
        'response.http.headers': forClient,
        'response.chat.openaiChatCompletions.rendered': move(
          await collectOpenAIChatCompletionsProtocolEventsToResult(frames) as unknown as Record<string, unknown>,
        ),
        'response.http.status': 200,
      };
    }
    return {
      ...rest,
      'response.chat.clientFrames': move(frames),
      'response.http.headers': forClient,
      'response.chat.openaiChatCompletions.rendered': move(renderSSE(frames, back['ingress.chat.openaiChatCompletions.wantsUsageChunk'])),
      'response.http.status': 200,
    };
  },
});

/** Metering asks the upstream for a usage chunk on every streaming turn; whether the client
 *  is shown it is the client's own question. The protocol owns which frame that is, and says
 *  so by writing no frame at all. */
const renderSSE = (
  frames: AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>,
  includeUsageChunk: boolean,
): AsyncIterable<SseFrame> => ({
  // The frames the client reads are a reframing of the ones the record holds, so this key
  // points at that same stream rather than at nothing.
  ...streamReferenceOf(frames),
  [Symbol.asyncIterator]: () => (async function* () {
    for await (const frame of frames) {
      const written = openaiChatCompletionsProtocolFrameToSSEFrame(frame, { includeUsageChunk });
      if (written !== null) yield written;
    }
  })(),
});
