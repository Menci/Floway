import { defineStage } from '../../pipeline/facts.ts';
import { jsonResponse, errorResponse } from '../shared/http.ts';

export const encodeOpenAIEmbeddings = defineStage({
  name: 'openaiEmbeddings.encode',
  through: {
    request: { needs: [], provides: [], consumes: [] },
    response: { needs: ['http', 'openaiEmbeddings', 'candidate?'], provides: ['http'], consumes: ['openaiEmbeddings'] },
  },
  async execute(facts, scope) {
    const { openaiEmbeddings: outcome, ...answer } = await scope.next(facts);
    if (outcome.kind === 'error') {
      scope.services.dump?.error(outcome.source === 'upstream' ? 'upstream' : 'gateway', answer.candidate?.upstreamId);
      return { ...answer, http: errorResponse(answer.http, outcome) };
    }
    const { http } = answer;
    if (http === null) throw new Error('OpenAIEmbeddings success requires an HTTP response');
    return { ...answer, http: jsonResponse(http, outcome.result) };
  },
});
