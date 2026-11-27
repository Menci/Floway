import { defineCopilotStage } from '../facts.ts';
import { formatOpenAIError } from '../shared/format-errors.ts';
import { ERROR_BODY_BYTES } from '../shared/wire-request.ts';
import { decodeOpenAIResponsesStream } from '@floway-dev/protocols/openai-responses';
import { parseUpstreamStream } from '@floway-dev/upstream';

export const parse = defineCopilotStage({
  name: 'copilot.openaiResponses.parse',
  through: {
    request: { needs: [], provides: [], consumes: [] },
    response: { needs: ['http', 'openaiResponses?'], provides: ['http', 'openaiResponses'], consumes: [] },
  },
  async execute(facts, scope) {
    const back = await scope.next(facts);
    const { http, openaiResponses: outcome } = back;
    if (outcome !== undefined) return { ...back, openaiResponses: outcome };
    if (http === null) throw new Error('Copilot openaiResponses has neither an HTTP response nor an outcome');
    const parsed = await parseUpstreamStream(http, scope, decodeOpenAIResponsesStream, formatOpenAIError, ERROR_BODY_BYTES);
    return { ...back, http: parsed.http, openaiResponses: parsed.outcome };
  },
});
