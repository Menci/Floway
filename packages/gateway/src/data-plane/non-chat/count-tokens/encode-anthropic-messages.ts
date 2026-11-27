import { defineStage } from './facts.ts';
import { encodedResponse, errorResponse, jsonResponse } from '../shared/http.ts';

export const encodeAnthropicMessagesCountTokens = defineStage({
  name: 'anthropicMessagesCountTokens.encode',
  through: {
    request: { needs: [], provides: [], consumes: [] },
    response: { needs: ['http', 'anthropicMessagesCountTokens'], provides: ['http'], consumes: ['anthropicMessagesCountTokens'] },
  },
  async execute(facts, scope) {
    const { http, anthropicMessagesCountTokens: outcome, ...answer } = await scope.next(facts);
    if (outcome.kind === 'error') return { ...answer, http: errorResponse(http, outcome) };
    if (http === null) throw new Error('Anthropic Messages count_tokens result requires an HTTP response');
    return { ...answer, http: outcome.result === null ? encodedResponse(http, null) : jsonResponse(http, outcome.result) };
  },
});
