import { jsonResponse, localResponseHead } from '../pipeline/encode.ts';
import { defineStage } from '../pipeline/facts.ts';
import type { DecisionProtocol } from '@floway-dev/protocols/common';
import { DecisionRequestValidationError, parseDecisionRequest } from '@floway-dev/protocols/decision';
import { parseJsonBody } from '@floway-dev/provider';

export const decisionError = (message: string) => ({ error: { message, type: 'api_error' } });

export const parseDecision = (dialect: DecisionProtocol) => defineStage({
  name: 'decision.parse',
  through: {
    request: { needs: ['request.http'], provides: ['request.decision'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  return: { provides: ['response.http', 'response.outcome'] },
  async execute(facts, scope) {
    const invalid = (message: string) => ({
      'response.http': jsonResponse(localResponseHead(400), decisionError(message)),
      'response.outcome': scope.createDeferred(async () => 'local' as const),
    });
    const parsed = parseJsonBody(facts['request.http'].body ?? new Uint8Array());
    if (!parsed.ok) return invalid('Decision request body must be valid JSON');

    let request: ReturnType<typeof parseDecisionRequest>['request'];
    try {
      ({ request } = parseDecisionRequest(dialect, parsed.value));
    } catch (error) {
      if (!(error instanceof DecisionRequestValidationError)) throw error;
      return invalid(error.message);
    }
    return await scope.next({ ...facts, 'request.decision': request });
  },
});
