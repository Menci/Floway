import { defineCopilotStage } from '../facts.ts';
import { formatOpenAIError } from '../shared/format-errors.ts';
import { ERROR_BODY_BYTES, RESULT_BODY_BYTES, readJsonObject } from '../shared/wire-request.ts';
import { parseUpstreamResult } from '@floway-dev/upstream';

export const parse = defineCopilotStage({
  name: 'copilot.openaiEmbeddings.parse',
  through: {
    request: { needs: [], provides: [], consumes: [] },
    response: { needs: ['http', 'openaiEmbeddings?'], provides: ['http', 'openaiEmbeddings'], consumes: [] },
  },
  async execute(facts, scope) {
    const back = await scope.next(facts);
    const { http, openaiEmbeddings: outcome } = back;
    if (outcome !== undefined) return { ...back, openaiEmbeddings: outcome };
    if (http === null) throw new Error('Copilot openaiEmbeddings has neither an HTTP response nor an outcome');
    const parsed = await parseUpstreamResult(http, scope, readJsonObject, formatOpenAIError, {
      maxResultBodyBytes: RESULT_BODY_BYTES,
      maxErrorBodyBytes: ERROR_BODY_BYTES,
    });
    return { ...back, http: parsed.http, openaiEmbeddings: parsed.outcome };
  },
});
