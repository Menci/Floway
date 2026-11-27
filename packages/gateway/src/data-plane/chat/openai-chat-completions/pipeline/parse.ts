import { openaiInternalErrorPayload } from '../../../shared/openai-errors.ts';
import { defineDeliveryStage, parseChatRequestBody } from '../../pipeline/delivery.ts';
import { jsonChatResponse, localChatHead } from '../../pipeline/encode.ts';
import type { OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';
import { toInternalDebugError } from '@floway-dev/upstream';

export const parseOpenAIChatCompletions = defineDeliveryStage({
  name: 'openaiChatCompletions.parse',
  through: {
    request: {
      needs: ['http'], provides: ['openaiChatCompletions', 'delivery', 'requestedModel'], consumes: ['ws.message', 'ws.eventId', 'ws.responseId'],
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
    const payload = body.value as unknown as OpenAIChatCompletionsPayloadEx;
    const nullableField = payload.prompt_cache_options === null ? 'prompt_cache_options' : payload.user === null ? 'user' : undefined;
    if (nullableField !== undefined) {
      scope.services.dump?.error('gateway');
      return {
        http: jsonChatResponse(localChatHead(400), {
          error: {
            message: `Invalid '${nullableField}': expected ${nullableField === 'user' ? 'a string' : 'an object'} when present.`,
            type: 'invalid_request_error',
            param: nullableField,
            code: null,
          },
        }),
      };
    }
    scope.services.dump?.requestedModel(payload.model);
    return await scope.next({
      ...facts,
      openaiChatCompletions: payload,
      delivery: {
        stream: payload.stream === true,
        includeUsageChunk: payload.stream_options?.include_usage === true,
        expectedChoices: payload.n ?? 1,
      },
      requestedModel: payload.model,
    });
  },
});
