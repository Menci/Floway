import type { OpenAIImagesFrames, Fields, OpenAIImagesFacts } from './facts.ts';
import { streamReferenceOf } from '../../dump/run-sink.ts';
import { isFailure, mintedErrorEnvelope, renderFailure } from '../pipeline/facts.ts';
import { isForwardableUpstreamHeader } from '../shared/upstream-response.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import { type SseFrame } from '@floway-dev/protocols/common';
import { renderOpenAIImagesResponse, openaiImagesStreamEventToSSEFrame, type CanonicalOpenAIImagesResponse } from '@floway-dev/protocols/openai-images';

const isFrames = (answer: CanonicalOpenAIImagesResponse | OpenAIImagesFrames): answer is OpenAIImagesFrames =>
  Symbol.asyncIterator in answer;

/**
 * The outermost edge. It names nothing on the way down — the family has one protocol, so there
 * is no request to read to know how to answer — and coming back it renders the answer, keeps
 * the upstream headers a client may see, and decides the status. The status is decided here
 * rather than carried up because a refusal that never reached an upstream has none to carry.
 *
 * SSE framing is produced here and nowhere else: below this stage a stream carries protocol
 * events, so the same assembly would serve another transport by rendering differently at this
 * one point.
 */
export const emitOpenAIImages = defineStage<
  Record<string, never>,
  Record<string, never>,
  Fields<'response.openaiImages.canonical' | 'response.http.headers'>,
  Fields<'response.openaiImages.rendered' | 'response.http.status' | 'response.http.headers'>
>({
  name: 'emitOpenAIImages',
  through: {
    request: { needs: [], consumes: [], provides: [] },
    response: {
      needs: ['response.openaiImages.canonical', 'response.http.headers'],
      consumes: ['response.openaiImages.canonical', 'response.http.headers'],
      provides: ['response.openaiImages.rendered', 'response.http.status', 'response.http.headers'],
    },
  },
  execute: async (facts, next) => {
    const back = await next(facts);
    const { 'response.openaiImages.canonical': answer, 'response.http.headers': headers, ...rest } = back;
    // Vendor traces and quota state stay visible; what an intermediary must strip, and what
    // would misdescribe a body this gateway serialized itself, does not. A filter that removed
    // nothing hands the same array on, so the record shows no change where none happened.
    const forwardable = headers.filter(([name]) => isForwardableUpstreamHeader(name));
    return {
      ...rest,
      'response.http.headers': forwardable.length === headers.length ? headers : move(forwardable),
      'response.http.status': isFailure(answer) ? answer.status : 200,
      'response.openaiImages.rendered': move(rendered(answer)),
    };
  },
});

const rendered = (answer: OpenAIImagesFacts['response.openaiImages.canonical']): OpenAIImagesFacts['response.openaiImages.rendered'] =>
  isFailure(answer) ? renderFailure(answer, mintedErrorEnvelope).body
    : isFrames(answer) ? renderSSE(answer)
      : renderOpenAIImagesResponse(answer);

const renderSSE = (frames: OpenAIImagesFrames): AsyncIterable<SseFrame> => ({
  // The frames the client reads are a reframing of the ones the record holds, so this key
  // points at that same stream rather than at nothing.
  ...streamReferenceOf(frames),
  [Symbol.asyncIterator]: () => (async function* () {
    for await (const event of frames) yield openaiImagesStreamEventToSSEFrame(event);
  })(),
});
