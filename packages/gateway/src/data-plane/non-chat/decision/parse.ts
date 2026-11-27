import { defineStage } from './facts.ts';
import { jsonResponse, localHead, openAIError, readJson } from '../shared/http.ts';
import { parseDecisionRequest } from '@floway-dev/protocols/decision';

export const parse = defineStage({
  name: 'decision.parse',
  through: {
    request: { needs: ['http', 'serve.startedAt', 'decisionDialect'], provides: ['decision', 'requestedModel'], consumes: ['decisionDialect'] },
    response: { needs: [], provides: [], consumes: [] },
  },
  return: { provides: ['http'] },
  async execute({ decisionDialect, ...facts }, scope) {
    const invalid = (message: string) => {
      scope.services.dump?.error('gateway');
      return { http: jsonResponse(localHead(400), openAIError(message)) };
    };
    const parsedBody = readJson(facts.http, 'Decision request body must be valid JSON');
    if (!parsedBody.ok) return invalid(parsedBody.error);

    let parsed: ReturnType<typeof parseDecisionRequest>;
    try {
      parsed = parseDecisionRequest(decisionDialect, parsedBody.value);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return invalid(error.message);
    }

    scope.services.dump?.requestedModel(parsed.model);
    return await scope.next({ ...facts, decision: parsed.request, requestedModel: parsed.model });
  },
});
