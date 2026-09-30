import type { OpenAICompletionsFacts, OpenAICompletionsFrames, Fields } from './facts.ts';
import { streamReferenceOf } from '../../dump/run-sink.ts';
import { isFailure, mintedErrorEnvelope, renderFailure } from '../pipeline/facts.ts';
import { isForwardableUpstreamHeader } from '../shared/upstream-response.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import { isOpenAIUsageOnlyEventShape, type SseFrame } from '@floway-dev/protocols/common';
import { openaiCompletionsProtocolFrameToSSEFrame } from '@floway-dev/protocols/openai-completions';

const isFrames = (answer: OpenAICompletionsFacts['response.openaiCompletions.payload']): answer is OpenAICompletionsFrames =>
  Symbol.asyncIterator in answer;

/**
 * The outermost edge, and the only place where what the client asked for and what the
 * upstream is asked for differ: billing needs the usage chunk on every stream, so it is
 * turned on going down and taken back out coming up unless the client asked to see it.
 *
 * Rendering the answer is the other half. SSE framing is produced here and nowhere else —
 * below this stage a stream carries protocol frames, so the same assembly would serve
 * another transport by rendering differently at this one point.
 */
export const emitOpenAICompletions = defineStage<
  Fields<'ingress.openaiCompletions.wantsStream' | 'ingress.openaiCompletions.wantsUsageChunk' | 'request.openaiCompletions.payload'>,
  Fields<'ingress.openaiCompletions.wantsStream' | 'ingress.openaiCompletions.wantsUsageChunk' | 'request.openaiCompletions.payload'>,
  Fields<'ingress.openaiCompletions.wantsUsageChunk' | 'response.openaiCompletions.payload' | 'response.http.status' | 'response.http.headers'>,
  Fields<'response.openaiCompletions.rendered' | 'response.http.status' | 'response.http.headers'>
>({
  name: 'emitOpenAICompletions',
  through: {
    request: {
      needs: ['ingress.openaiCompletions.wantsStream', 'ingress.openaiCompletions.wantsUsageChunk', 'request.openaiCompletions.payload'],
      consumes: [],
      provides: ['request.openaiCompletions.payload'],
    },
    response: {
      needs: ['response.openaiCompletions.payload', 'response.http.headers', 'response.http.status'],
      consumes: ['response.openaiCompletions.payload', 'response.http.headers'],
      provides: ['response.openaiCompletions.rendered', 'response.http.status', 'response.http.headers'],
    },
  },
  execute: async (facts, next) => {
    const asked = facts['request.openaiCompletions.payload'];
    const back = await next({
      ...facts,
      'request.openaiCompletions.payload': move(facts['ingress.openaiCompletions.wantsStream']
        ? { ...asked, stream_options: { ...asked.stream_options, include_usage: true } }
        : asked),
    });

    const { 'response.openaiCompletions.payload': answer, 'response.http.headers': headers, ...rest } = back;
    // Vendor traces and quota state stay visible; what an intermediary must strip, and what
    // would misdescribe a body this gateway serialized itself, does not. A filter that removed
    // nothing hands the same array on, so the record shows no change where none happened.
    const forwardable = headers.filter(([name]) => isForwardableUpstreamHeader(name));
    return {
      ...rest,
      'response.http.headers': forwardable.length === headers.length ? headers : move(forwardable),
      'response.http.status': isFailure(answer) ? answer.status : back['response.http.status'],
      'response.openaiCompletions.rendered': move(rendered(answer, back['ingress.openaiCompletions.wantsUsageChunk'])),
    };
  },
});

const rendered = (
  answer: OpenAICompletionsFacts['response.openaiCompletions.payload'],
  wantsUsageChunk: boolean,
): OpenAICompletionsFacts['response.openaiCompletions.rendered'] =>
  isFailure(answer) ? renderFailure(answer, mintedErrorEnvelope).body
    : isFrames(answer) ? renderSSE(answer, wantsUsageChunk)
      : answer;

const renderSSE = (frames: OpenAICompletionsFrames, wantsUsageChunk: boolean): AsyncIterable<SseFrame> => ({
  // The frames the client reads are a reframing of the ones the record holds, so this key
  // points at that same stream rather than at nothing.
  ...streamReferenceOf(frames),
  [Symbol.asyncIterator]: () => (async function* () {
    for await (const frame of frames) {
      if (!wantsUsageChunk && frame.type === 'event' && isOpenAIUsageOnlyEventShape(frame.event)) continue;
      yield openaiCompletionsProtocolFrameToSSEFrame(frame);
    }
  })(),
});
