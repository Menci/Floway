import { openAIResponsesDelivery } from './parse.ts';
import { defineDeliveryStage } from '../../pipeline/delivery.ts';
import { localChatHead } from '../../pipeline/encode.ts';
import { isJsonObject } from '@floway-dev/protocols/common';
import { canonicalizeOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import type { ProtocolError } from '@floway-dev/upstream';

export const parseOpenAIResponsesWebSocket = defineDeliveryStage({
  name: 'openaiResponses.parse-websocket',
  through: {
    request: { needs: ['ws.message', 'serve.startedAt'], provides: ['openaiResponses', 'delivery', 'requestedModel'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  return: { provides: ['http', 'openaiResponses'] },
  async execute(facts, scope) {
    const fail = (message: string, fields: { code?: string; param?: string | null } = {}) => {
      scope.services.dump?.error('gateway');
      const openaiResponses: ProtocolError = {
        kind: 'error',
        source: 'local',
        error: { error: { type: 'invalid_request_error', code: 'invalid_request_error', message, ...fields } },
      };
      return { http: localChatHead(400), openaiResponses };
    };
    const { type, event_id: _eventId, ...body } = facts['ws.message'];
    if (typeof type !== 'string') return fail('WebSocket message must be a JSON object with a string type.');
    if (type !== 'response.create') return fail(`Unsupported WebSocket event type '${type}'.`);

    const payload = canonicalizeOpenAIResponsesPayload({ ...(isJsonObject(body.response) ? body.response : body), stream: true });
    if (!('input' in payload)) return fail(payload.error.message, payload.error);

    scope.services.dump?.requestedModel(payload.model);
    return await scope.next({
      ...facts,
      openaiResponses: payload,
      delivery: openAIResponsesDelivery(true, facts['serve.startedAt'], payload.store),
      requestedModel: payload.model,
    });
  },
});
