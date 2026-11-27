import { COUNT_RESULT_BODY_BYTES, customModelRequest, customResult, decodeJson, defineStage, dialResponseConsumes, dialResponseNeeds, nullableCountResult } from '../http.ts';
import { decodeAnthropicMessagesCountTokensResult } from '@floway-dev/protocols/anthropic-messages';
import { isJsonObject } from '@floway-dev/protocols/common';

export const anthropicMessagesCountTokensDial = defineStage({
  name: 'custom.anthropicMessagesCountTokens.dial',
  through: {
    request: { needs: ['http', 'upstream', 'model', 'anthropicMessagesCountTokens'], provides: ['http'], consumes: [] },
    response: { needs: dialResponseNeeds, provides: ['http', 'anthropicMessagesCountTokens'], consumes: dialResponseConsumes },
  },
  async execute(facts, scope) {
    const { http, upstream, model, anthropicMessagesCountTokens } = facts;
    const request = customModelRequest(http, upstream, '/messages', model.upstreamModelId, anthropicMessagesCountTokens, 'x-api-key', '/count_tokens');
    const answer = await scope.next({ ...facts, http: request });
    const parsed = await customResult(answer, scope, nullableCountResult(decodeJson(decodeCustomAnthropicCount)), COUNT_RESULT_BODY_BYTES, 'x-api-key');
    return { http: parsed.http, anthropicMessagesCountTokens: parsed.outcome };
  },
});

const decodeCustomAnthropicCount = (value: unknown) => {
  if (isJsonObject(value) && !Object.hasOwn(value, 'input_tokens') && Object.hasOwn(value, 'total_tokens')) {
    return decodeAnthropicMessagesCountTokensResult({ ...value, input_tokens: value.total_tokens });
  }
  return decodeAnthropicMessagesCountTokensResult(value);
};
