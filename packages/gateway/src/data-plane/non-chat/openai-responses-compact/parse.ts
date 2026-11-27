import { defineStage } from './facts.ts';
import { parseChatRequestBody } from '../../chat/pipeline/delivery.ts';
import { jsonResponse, localHead } from '../shared/http.ts';
import { canonicalizeOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';

export const parseOpenAIResponsesCompact = defineStage({
  name: 'openaiResponsesCompact.parse',
  through: {
    request: { needs: ['http'], provides: ['openaiResponsesCompact', 'requestedModel'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  return: { provides: ['http'] },
  async execute(facts, scope) {
    const body = parseChatRequestBody(facts.http.body);
    const payload = body.ok ? canonicalizeOpenAIResponsesPayload(body.value) : { error: { message: body.error.message, param: 'input', code: null } };
    if (!('input' in payload)) {
      scope.services.dump?.error('gateway');
      const { message, param, code } = payload.error;
      return { http: jsonResponse(localHead(400), { error: { message, type: 'invalid_request_error', param: param ?? 'input', code: code ?? null } }) };
    }
    scope.services.dump?.requestedModel(payload.model);
    return await scope.next({ ...facts, openaiResponsesCompact: payload, requestedModel: payload.model });
  },
});
