import { compactionResponse } from '../../compaction.ts';
import { defineCopilotStage } from '../facts.ts';
import { formatOpenAIError } from '../shared/format-errors.ts';
import { ERROR_BODY_BYTES, RESULT_BODY_BYTES } from '../shared/wire-request.ts';
import { decodeOpenAIResponsesCompactionResult, isOpenAIResponsesCompactionItem } from '@floway-dev/protocols/openai-responses';
import { parseJsonBody, parseUpstreamResult } from '@floway-dev/upstream';

export const parse = defineCopilotStage({
  name: 'copilot.openaiResponsesCompact.parse',
  through: {
    request: { needs: ['openaiResponsesCompact'], provides: [], consumes: [] },
    response: { needs: ['http', 'openaiResponsesCompact?'], provides: ['http', 'openaiResponsesCompact'], consumes: [] },
  },
  async execute(facts, scope) {
    const back = await scope.next(facts);
    const { http, openaiResponsesCompact: outcome } = back;
    if (outcome !== undefined) return { ...back, openaiResponsesCompact: outcome };
    if (http === null) throw new Error('Copilot openaiResponsesCompact has neither an HTTP response nor an outcome');
    const parsed = await parseUpstreamResult(http, scope, bytes => {
      const parsed = parseJsonBody(bytes);
      if (!parsed.ok) return parsed;
      const decoded = decodeOpenAIResponsesCompactionResult(parsed.value);
      if (!decoded.ok) return decoded;
      if (!decoded.value.output.some(isOpenAIResponsesCompactionItem)) {
        return { ok: false, error: new Error("Copilot's compaction trigger turn returned no compaction output item") };
      }
      return { ok: true, value: compactionResponse(facts.openaiResponsesCompact.input, decoded.value) };
    }, formatOpenAIError, {
      maxResultBodyBytes: RESULT_BODY_BYTES,
      maxErrorBodyBytes: ERROR_BODY_BYTES,
    });
    return { ...back, http: parsed.http, openaiResponsesCompact: parsed.outcome };
  },
});
