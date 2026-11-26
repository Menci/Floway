import { jsonResponse } from '../../../pipeline/encode.ts';
import { defineStage } from '../../../pipeline/facts.ts';
import { openAIResponsesLocalError } from '../errors.ts';
import { parseOpenAIResponsesJson } from '../parse.ts';
import { canonicalizeOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';

export const parseOpenAIResponsesCompact = defineStage({
  name: 'openaiResponsesCompact.parse',
  through: {
    request: { needs: ['request.http'], provides: ['request.openaiResponsesCompact'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  return: { provides: ['response.http', 'response.outcome'] },
  async execute(facts, scope) {
    const body = parseOpenAIResponsesJson(facts['request.http'].body);
    const payload = 'error' in body ? { error: { message: body.error } } : canonicalizeOpenAIResponsesPayload(body.value);
    if (!('input' in payload)) {
      const { message, param, code } = payload.error;
      const { http, outcome } = openAIResponsesLocalError(400, message, { param: param ?? 'input', code: code ?? null });
      return {
        'response.http': jsonResponse(http, outcome.error),
        'response.outcome': scope.createDeferred(async () => 'local' as const),
      };
    }

    return await scope.next({
      ...facts,
      'request.openaiResponsesCompact': payload,
    });
  },
});
