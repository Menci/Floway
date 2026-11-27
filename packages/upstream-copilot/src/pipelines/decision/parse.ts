import { defineCopilotStage } from '../facts.ts';
import { formatOpenAIError } from '../shared/format-errors.ts';
import { ERROR_BODY_BYTES, RESULT_BODY_BYTES } from '../shared/wire-request.ts';
import { parseUpstreamResult } from '@floway-dev/upstream';

export const parse = defineCopilotStage({
  name: 'copilot.decision.parse',
  through: {
    request: { needs: [], provides: [], consumes: [] },
    response: { needs: ['http', 'decision?'], provides: ['http', 'decision'], consumes: [] },
  },
  async execute(facts, scope) {
    const back = await scope.next(facts);
    const { http, decision: outcome } = back;
    if (outcome !== undefined) return { ...back, decision: outcome };
    if (http === null) throw new Error('Copilot decision has neither an HTTP response nor an outcome');
    const parsed = await parseUpstreamResult(http, scope, bytes => ({ ok: true, value: bytes }), formatOpenAIError, {
      maxResultBodyBytes: RESULT_BODY_BYTES,
      maxErrorBodyBytes: ERROR_BODY_BYTES,
    });
    return { ...back, http: parsed.http, decision: parsed.outcome };
  },
});
