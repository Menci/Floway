import { defineStage } from '../../pipeline/facts.ts';
import { encodedResponse, errorResponse, jsonResponse } from '../shared/http.ts';

export const encode = defineStage({
  name: 'alphaSearch.encode',
  through: {
    request: { needs: [], provides: [], consumes: [] },
    response: { needs: ['http', 'alphaSearch'], provides: ['http'], consumes: ['alphaSearch'] },
  },
  async execute(facts, scope) {
    const { http, alphaSearch, ...answer } = await scope.next(facts);
    if (alphaSearch.kind === 'error') {
      if (alphaSearch.source === 'local') scope.services.dump?.error('gateway');
      return { ...answer, http: errorResponse(http, alphaSearch) };
    }
    if (http === null) throw new Error('An Alpha Search result requires an HTTP response');
    return {
      ...answer,
      http: alphaSearch.result instanceof Uint8Array
        ? encodedResponse(http, alphaSearch.result)
        : jsonResponse(http, alphaSearch.result),
    };
  },
});
