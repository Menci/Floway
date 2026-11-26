import { jsonResponse, localResponseHead } from '../../pipeline/encode.ts';
import type { GatewayPipelineFacts } from '../../pipeline/facts.ts';
import type { GatewayServices } from '../../pipeline/services.ts';
import { openaiInternalErrorPayload } from '../../shared/openai-errors.ts';
import { factSpace } from '@floway-dev/pipeline';
import { isJsonObject } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';
import { parseJsonBody, toInternalDebugError } from '@floway-dev/provider';

export interface OpenAIChatCompletionsDelivery {
  stream: boolean;
  includeUsageChunk: boolean;
  expectedChoices: number;
}

const { defineStage } = factSpace<GatewayPipelineFacts & { 'request.delivery': OpenAIChatCompletionsDelivery }, GatewayServices>();

export const parseOpenAIChatCompletions = defineStage({
  name: 'openaiChatCompletions.parse',
  through: {
    request: { needs: ['request.http'], provides: ['request.openaiChatCompletions', 'request.delivery'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  return: { provides: ['response.http', 'response.outcome'] },
  async execute(facts, scope) {
    const reject = (status: number, body: unknown) => ({
      'response.http': jsonResponse(localResponseHead(status), body),
      'response.outcome': scope.createDeferred(async () => 'local' as const),
    });
    const parsed = parseJsonBody(facts['request.http'].body ?? new Uint8Array());
    if (!parsed.ok || !isJsonObject(parsed.value)) {
      const error = parsed.ok ? new TypeError('Expected an OpenAI Chat Completions request object') : parsed.error;
      return reject(502, openaiInternalErrorPayload(toInternalDebugError(error)));
    }
    const payload = parsed.value as unknown as OpenAIChatCompletionsPayloadEx;
    const nullableField = payload.prompt_cache_options === null ? 'prompt_cache_options' : payload.user === null ? 'user' : undefined;
    if (nullableField !== undefined) {
      return reject(400, {
        error: {
          message: `Invalid '${nullableField}': expected ${nullableField === 'user' ? 'a string' : 'an object'} when present.`,
          type: 'invalid_request_error',
          param: nullableField,
          code: null,
        },
      });
    }
    return await scope.next({
      ...facts,
      'request.openaiChatCompletions': payload,
      'request.delivery': {
        stream: payload.stream === true,
        includeUsageChunk: payload.stream_options?.include_usage === true,
        expectedChoices: payload.n ?? 1,
      },
    });
  },
});
