import { defineStage } from './facts.ts';
import { encodedResponse, errorResponse, jsonResponse } from '../shared/http.ts';
import { getHeader } from '@floway-dev/http';
import { renderDecisionResponse } from '@floway-dev/protocols/decision';

export const encode = defineStage({
  name: 'decision.encode',
  through: {
    request: { needs: ['decision'], provides: [], consumes: [] },
    response: { needs: ['http', 'decision'], provides: ['http'], consumes: ['decision'] },
  },
  async execute(facts, scope) {
    const { http, decision, ...answer } = await scope.next(facts);
    if (decision.kind === 'error') return { ...answer, http: errorResponse(http, decision) };
    if (http === null) throw new Error('A decision result requires an HTTP response');
    const { result } = decision;
    const response = result instanceof Uint8Array
      ? encodedResponse(http, result, getHeader(http.headers, 'content-type') === undefined ? 'application/json' : undefined)
      : jsonResponse(http, renderDecisionResponse(facts.decision.sourceProtocol, result));
    return { ...answer, http: response };
  },
});
