import { selectKimiCodeMessagesModel } from '../../model-selection.ts';
import { kimiCodeMessagesWireBody } from '../../speed.ts';
import { defineStage } from '../facts.ts';
import { prepareKimiCodeRequest } from '../request.ts';
import { formatAnthropicError, invalidSpeed, MAX_KIMI_CODE_COUNT_TOKENS_BODY_BYTES, MAX_KIMI_CODE_ERROR_BODY_BYTES } from '../response.ts';
import { decodeAnthropicMessagesCountTokensResult, type AnthropicMessagesCountTokensResult } from '@floway-dev/protocols/anthropic-messages';
import { httpDialError, parseJsonBody, parseUpstreamResult } from '@floway-dev/upstream';

export const dialAnthropicMessagesCountTokens = defineStage({
  name: 'kimi-code.anthropicMessagesCountTokens.dial',
  through: {
    request: { needs: ['http', 'upstream', 'model', 'anthropicMessagesCountTokens'], provides: ['http'], consumes: [] },
    response: { needs: ['http', 'http.error?'], provides: ['http', 'anthropicMessagesCountTokens', 'usageModelKey?'], consumes: ['http.error'] },
  },
  return: { provides: ['http', 'anthropicMessagesCountTokens'] },
  async execute(facts, scope) {
    const { http, model, anthropicMessagesCountTokens: payload, upstream } = facts;
    const selection = selectKimiCodeMessagesModel(model, payload.speed);
    if (!selection.ok) {
      const { http, outcome } = invalidSpeed(selection.error, formatAnthropicError);
      return { http, anthropicMessagesCountTokens: outcome };
    }
    const { modelId } = selection.value;
    const usageModel = modelId === model.upstreamModelId ? {} : { usageModelKey: modelId };
    const body = { ...kimiCodeMessagesWireBody(payload), model: modelId };
    const { 'http.error': failure, ...answer } = await scope.next({ ...facts, http: prepareKimiCodeRequest(http, upstream, '/messages/count_tokens', body) });
    if (failure !== undefined) {
      return { ...answer, ...(failure.kind !== 'abort' && usageModel), anthropicMessagesCountTokens: httpDialError(failure, formatAnthropicError) };
    }
    if (answer.http === null) throw new Error('Expected Kimi Code HTTP response headers or a dial error');
    const parsed = await parseUpstreamResult<AnthropicMessagesCountTokensResult | null>(answer.http, scope, (bytes, { status }) => {
      if (status === 204 || status === 205) return { ok: true, value: null };
      const json = parseJsonBody(bytes);
      return json.ok ? decodeAnthropicMessagesCountTokensResult(json.value) : json;
    }, formatAnthropicError, { maxResultBodyBytes: MAX_KIMI_CODE_COUNT_TOKENS_BODY_BYTES, maxErrorBodyBytes: MAX_KIMI_CODE_ERROR_BODY_BYTES });
    return { ...answer, ...usageModel, http: parsed.http, anthropicMessagesCountTokens: parsed.outcome };
  },
});
