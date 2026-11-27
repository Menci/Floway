import { defineStage } from './facts.ts';
import { errorResponse, jsonResponse, localHead } from '../shared/http.ts';

export const encodeOpenAIResponsesCompact = defineStage({
  name: 'openaiResponsesCompact.encode',
  through: {
    request: { needs: [], provides: [], consumes: [] },
    response: { needs: ['http', 'openaiResponsesCompact'], provides: ['http'], consumes: ['openaiResponsesCompact'] },
  },
  async execute(facts, scope) {
    const { http, openaiResponsesCompact: outcome, ...answer } = await scope.next(facts);
    return { ...answer, http: outcome.kind === 'error' ? errorResponse(http, outcome) : jsonResponse(http ?? localHead(200), outcome.result) };
  },
});
