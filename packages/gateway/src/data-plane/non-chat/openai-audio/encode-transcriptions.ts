import { defineStage } from '../../pipeline/facts.ts';
import { encodedResponse, encodeSse, errorResponse } from '../shared/http.ts';
import { eventFrame } from '@floway-dev/protocols/common';
import type { OpenAIAudioTranscriptionStreamItem } from '@floway-dev/protocols/openai-audio';

export const encodeOpenAIAudioTranscriptions = defineStage({
  name: 'openaiAudioTranscriptions.encode',
  through: {
    request: { needs: [], provides: [], consumes: [] },
    response: { needs: ['http', 'openaiAudioTranscriptions', 'candidate?'], provides: ['http'], consumes: ['openaiAudioTranscriptions'] },
  },
  async execute(facts, scope) {
    const { openaiAudioTranscriptions: outcome, ...answer } = await scope.next(facts);
    if (outcome.kind === 'error') {
      scope.services.dump?.error(outcome.source === 'upstream' ? 'upstream' : 'gateway', answer.candidate?.upstreamId);
      return { ...answer, http: errorResponse(answer.http, outcome) };
    }
    const { http } = answer;
    if (http === null) throw new Error('OpenAIAudioTranscriptions success requires an HTTP response');
    if (outcome.kind === 'result') return { ...answer, http: encodedResponse(http, outcome.result) };
    const body = encodeSse<OpenAIAudioTranscriptionStreamItem>(outcome.stream, scope, ({ data }) => eventFrame(data), undefined, item => item.eventName);
    return { ...answer, http: encodedResponse(http, body, 'text/event-stream') };
  },
});
