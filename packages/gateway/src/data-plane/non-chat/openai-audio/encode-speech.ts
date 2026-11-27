import { defineStage } from '../../pipeline/facts.ts';
import { encodedResponse, encodeSse, errorResponse } from '../shared/http.ts';
import { eventFrame } from '@floway-dev/protocols/common';

export const encodeOpenAIAudioSpeech = defineStage({
  name: 'openaiAudioSpeech.encode',
  through: {
    request: { needs: [], provides: [], consumes: [] },
    response: { needs: ['http', 'openaiAudioSpeech', 'candidate?'], provides: ['http'], consumes: ['openaiAudioSpeech'] },
  },
  async execute(facts, scope) {
    const { openaiAudioSpeech: outcome, ...answer } = await scope.next(facts);
    if (outcome.kind === 'error') {
      scope.services.dump?.error(outcome.source === 'upstream' ? 'upstream' : 'gateway', answer.candidate?.upstreamId);
      return { ...answer, http: errorResponse(answer.http, outcome) };
    }
    const { http } = answer;
    if (http === null) throw new Error('OpenAIAudioSpeech success requires an HTTP response');
    if (outcome.kind === 'result') return { ...answer, http: encodedResponse(http, outcome.result) };
    const body = encodeSse(outcome.stream, scope, eventFrame);
    return { ...answer, http: encodedResponse(http, body, 'text/event-stream') };
  },
});
