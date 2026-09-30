import type { OpenAIAudioTranscriptionEvents, Fields } from './facts.ts';
import { streamReferenceOf } from '../../dump/turn-dump.ts';
import { isFailure } from '../pipeline/facts.ts';
import { isForwardableUpstreamHeader } from '../shared/upstream-response.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import { renderErrorEnvelope, sseFrame, type SseFrame } from '@floway-dev/protocols/common';
import { renderOpenAIAudioTranscription, type CanonicalOpenAIAudioTranscription } from '@floway-dev/protocols/openai-audio';

const isEvents = (answer: CanonicalOpenAIAudioTranscription | OpenAIAudioTranscriptionEvents): answer is OpenAIAudioTranscriptionEvents =>
  Symbol.asyncIterator in answer;

/**
 * The outermost edge. Writes the answer back in the rendering the client asked for, and names
 * a media type for the one body the gateway wrote out of nothing the upstream sent — its
 * error envelope. Every other answer goes out under the media type it arrived with, because
 * for a document that is carried rather than rewritten the upstream's label is the only true
 * description there is.
 *
 * SSE framing is produced here and nowhere else — below this stage the answer is parsed
 * events, so the same assembly would serve another transport by rendering differently at
 * this one point. The upstream's own `event:` label is not carried: it is transport, and
 * OpenAI's clients read this endpoint's frames by their payload's `type` rather than by the
 * label. https://github.com/openai/openai-python/blob/10ee3f0da2ac6f93345c1204bd7bb1a2faa79ff2/src/openai/_streaming.py#L61-L107
 */
export const emitOpenAIAudioTranscription = defineStage<
  Fields<'ingress.openaiAudioTranscription.responseFormat'>,
  Fields<'ingress.openaiAudioTranscription.responseFormat'>,
  Fields<'ingress.openaiAudioTranscription.responseFormat' | 'response.openaiAudioTranscription.canonical' | 'response.openaiAudioTranscription.mediaType'>
    & { 'response.http.headers': readonly (readonly [string, string])[] },
  Fields<'response.openaiAudioTranscription.rendered' | 'response.openaiAudioTranscription.mediaType'>
    & { 'response.http.status': number; 'response.http.headers': readonly (readonly [string, string])[] }
>({
  name: 'emitOpenAIAudioTranscription',
  through: {
    request: {
      needs: ['ingress.openaiAudioTranscription.responseFormat'],
      consumes: [],
      provides: [],
    },
    response: {
      needs: ['response.openaiAudioTranscription.canonical', 'response.openaiAudioTranscription.mediaType', 'response.http.headers'],
      consumes: ['response.openaiAudioTranscription.canonical', 'response.http.headers'],
      provides: ['response.openaiAudioTranscription.rendered', 'response.openaiAudioTranscription.mediaType', 'response.http.status', 'response.http.headers'],
    },
  },
  execute: async (facts, next) => {
    const back = await next(facts);
    const { 'response.openaiAudioTranscription.canonical': answer, 'response.http.headers': headers, ...rest } = back;
    // Vendor traces and quota state stay visible; what an intermediary must strip, and what
    // would misdescribe a body this gateway serialized itself, does not. A filter that removed
    // nothing hands the same array on, so the record shows no change where none happened.
    const forwardable = headers.filter(([name]) => isForwardableUpstreamHeader(name));
    const forClient = forwardable.length === headers.length ? headers : move(forwardable);

    if (isFailure(answer)) {
      return {
        ...rest,
        'response.http.headers': forClient,
        'response.http.status': answer.status,
        'response.openaiAudioTranscription.mediaType': 'application/json',
        'response.openaiAudioTranscription.rendered': move(renderErrorEnvelope(answer.message, answer.body)),
      };
    }
    // Everything that reaches here answered. The same key carried the upstream's own status
    // further down; re-providing it is what makes the top of the record the response the
    // client gets rather than the one the upstream gave.
    return {
      ...rest,
      'response.http.headers': forClient,
      'response.http.status': 200,
      'response.openaiAudioTranscription.rendered': move(isEvents(answer)
        ? renderSSE(answer)
        : renderOpenAIAudioTranscription(back['ingress.openaiAudioTranscription.responseFormat'], answer)),
    };
  },
});

const renderSSE = (events: OpenAIAudioTranscriptionEvents): AsyncIterable<SseFrame> => ({
  // The frames the client reads are a reframing of the events the record holds, so this key
  // points at that same stream rather than at nothing.
  ...streamReferenceOf(events),
  [Symbol.asyncIterator]: () => (async function* () {
    for await (const event of events) yield sseFrame(JSON.stringify(event));
  })(),
});
