import { defineStage } from '../../pipeline/facts.ts';
import { jsonResponse, encodedResponse, encodeSse, errorResponse } from '../shared/http.ts';
import { eventFrame } from '@floway-dev/protocols/common';
import type { OpenAIImagesStreamItem } from '@floway-dev/protocols/openai-images';

export const encodeOpenAIImagesGenerations = defineStage({
  name: 'openaiImagesGenerations.encode',
  through: {
    request: { needs: [], provides: [], consumes: [] },
    response: { needs: ['http', 'openaiImagesGenerations', 'candidate?'], provides: ['http'], consumes: ['openaiImagesGenerations'] },
  },
  async execute(facts, scope) {
    const { openaiImagesGenerations: outcome, ...answer } = await scope.next(facts);
    if (outcome.kind === 'error') {
      scope.services.dump?.error(outcome.source === 'upstream' ? 'upstream' : 'gateway', answer.candidate?.upstreamId);
      return { ...answer, http: errorResponse(answer.http, outcome) };
    }
    const { http } = answer;
    if (http === null) throw new Error('OpenAIImagesGenerations success requires an HTTP response');
    if (outcome.kind === 'result') return { ...answer, http: jsonResponse(http, outcome.result) };
    const body = encodeSse<OpenAIImagesStreamItem>(outcome.stream, scope, item => eventFrame(item.data), undefined, item => item.eventName);
    return { ...answer, http: encodedResponse(http, body, 'text/event-stream') };
  },
});
