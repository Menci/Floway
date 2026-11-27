import { openaiInternalErrorPayload } from '../../../shared/openai-errors.ts';
import { defineDeliveryStage, parseChatRequestBody, type ChatDelivery } from '../../pipeline/delivery.ts';
import { jsonChatResponse, localChatHead } from '../../pipeline/encode.ts';
import { canonicalizeOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import { toInternalDebugError } from '@floway-dev/upstream';

export const openAIResponsesDelivery = (stream: boolean, startedAt: number, store: boolean | null | undefined): ChatDelivery => ({
  stream,
  createdAt: Math.floor(startedAt / 1000),
  ...(store == null ? {} : { store }),
});

export const parseOpenAIResponses = defineDeliveryStage({
  name: 'openaiResponses.parse',
  through: {
    request: {
      needs: ['http', 'serve.startedAt'], provides: ['openaiResponses', 'delivery', 'requestedModel'], consumes: ['ws.message', 'ws.eventId', 'ws.responseId'],
    },
    response: { needs: [], provides: [], consumes: [] },
  },
  return: { provides: ['http'] },
  async execute(facts, scope) {
    const body = parseChatRequestBody(facts.http.body);
    if (!body.ok) {
      scope.services.dump?.failed(body.error);
      return { http: jsonChatResponse(localChatHead(502), openaiInternalErrorPayload(toInternalDebugError(body.error))) };
    }
    const payload = canonicalizeOpenAIResponsesPayload(body.value);
    if (!('input' in payload)) {
      scope.services.dump?.error('gateway');
      const { message, param, code } = payload.error;
      return {
        http: jsonChatResponse(localChatHead(400), { error: { message, type: 'invalid_request_error', param: param ?? 'input', code: code ?? null } }),
      };
    }
    scope.services.dump?.requestedModel(payload.model);
    return await scope.next({
      ...facts,
      openaiResponses: payload,
      delivery: openAIResponsesDelivery(payload.stream === true, facts['serve.startedAt'], payload.store),
      requestedModel: payload.model,
    });
  },
});
