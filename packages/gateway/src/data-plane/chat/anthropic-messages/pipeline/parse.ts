import { defineDeliveryStage, parseChatRequestBody } from '../../pipeline/delivery.ts';
import { jsonChatResponse, localChatHead } from '../../pipeline/encode.ts';
import { anthropicMessagesDebugError } from '../errors.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';

export const parseAnthropicMessages = defineDeliveryStage({
  name: 'anthropicMessages.parse',
  through: {
    request: {
      needs: ['http'], provides: ['anthropicMessages', 'delivery', 'requestedModel'], consumes: ['ws.message', 'ws.eventId', 'ws.responseId'],
    },
    response: { needs: [], provides: [], consumes: [] },
  },
  return: { provides: ['http'] },
  async execute(facts, scope) {
    const body = parseChatRequestBody(facts.http.body);
    if (!body.ok) {
      scope.services.dump?.failed(body.error);
      return { http: jsonChatResponse(localChatHead(502), anthropicMessagesDebugError(body.error)) };
    }

    const field = Object.hasOwn(body.value, 'anthropic_beta') ? 'anthropic_beta' : Object.hasOwn(body.value, 'betas') ? 'betas' : undefined;
    if (field !== undefined) {
      scope.services.dump?.error('gateway');
      return {
        http: jsonChatResponse(localChatHead(400), {
          error: {
            message: `${field} in the Anthropic Messages request body is not supported; send Anthropic beta flags with the anthropic-beta HTTP header.`,
            type: 'invalid_request_error',
            param: field,
          },
        }),
      };
    }
    const payload = body.value as unknown as AnthropicMessagesPayload;
    scope.services.dump?.requestedModel(payload.model);
    return await scope.next({ ...facts, anthropicMessages: payload, delivery: { stream: payload.stream === true }, requestedModel: payload.model });
  },
});
