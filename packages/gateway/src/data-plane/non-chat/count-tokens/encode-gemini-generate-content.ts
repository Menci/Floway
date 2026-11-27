import { defineStage } from './facts.ts';
import { encodedResponse, errorResponse, jsonResponse } from '../shared/http.ts';

export const encodeGeminiGenerateContentCountTokens = defineStage({
  name: 'geminiGenerateContentCountTokens.encode',
  through: {
    request: { needs: [], provides: [], consumes: [] },
    response: { needs: ['http', 'geminiGenerateContentCountTokens'], provides: ['http'], consumes: ['geminiGenerateContentCountTokens'] },
  },
  async execute(facts, scope) {
    const { http, geminiGenerateContentCountTokens: outcome, ...answer } = await scope.next(facts);
    if (outcome.kind === 'error') {
      scope.services.dump?.selectUpstreamTranslationError(outcome);
      return { ...answer, http: errorResponse(http, outcome) };
    }
    if (http === null) throw new Error('Gemini countTokens result requires an HTTP response');
    return { ...answer, http: outcome.result === null ? encodedResponse(http, null) : jsonResponse(http, outcome.result) };
  },
});
