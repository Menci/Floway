import { mistralChatRequest } from './normalize-vendor/mistral.ts';
import { selectKimiCodeOpenAIModel } from '../../model-selection.ts';
import { setKimiCodeChatCompletionsTier } from '../../speed.ts';
import { defineStage } from '../facts.ts';
import { prepareKimiCodeRequest } from '../request.ts';
import { formatOpenAIError, invalidSpeed, mapProtocolEvents, MAX_KIMI_CODE_ERROR_BODY_BYTES } from '../response.ts';
import { decodeOpenAIChatCompletionsStream } from '@floway-dev/protocols/openai-chat-completions';
import { httpDialError, parseUpstreamStream } from '@floway-dev/upstream';

export const dialOpenAIChatCompletions = defineStage({
  name: 'kimi-code.openaiChatCompletions.dial',
  through: {
    request: { needs: ['http', 'upstream', 'model', 'openaiChatCompletions'], provides: ['http'], consumes: [] },
    response: { needs: ['http', 'http.error?'], provides: ['http', 'openaiChatCompletions', 'usageModelKey?'], consumes: ['http.error'] },
  },
  return: { provides: ['http', 'openaiChatCompletions'] },
  async execute(facts, scope) {
    const { http, model, openaiChatCompletions: payload, upstream } = facts;
    const selection = selectKimiCodeOpenAIModel(model, payload.service_tier);
    if (!selection.ok) {
      const { http, outcome } = invalidSpeed(selection.error, formatOpenAIError);
      return { http, openaiChatCompletions: outcome };
    }
    const { modelId, tier } = selection.value;
    const usageModel = modelId === model.upstreamModelId ? {} : { usageModelKey: modelId };
    const wire = model.enabledFlags.includes('vendor-mistral') ? mistralChatRequest(payload) : payload;
    const body = { ...wire, ...(tier !== undefined && { service_tier: tier }), model: modelId, stream: true };
    const { 'http.error': failure, ...answer } = await scope.next({ ...facts, http: prepareKimiCodeRequest(http, upstream, '/chat/completions', body) });
    if (failure !== undefined) {
      return { ...answer, ...(failure.kind !== 'abort' && usageModel), openaiChatCompletions: httpDialError(failure, formatOpenAIError) };
    }
    if (answer.http === null) throw new Error('Expected Kimi Code HTTP response headers or a dial error');
    const decode = tier === undefined ? decodeOpenAIChatCompletionsStream : mapProtocolEvents(decodeOpenAIChatCompletionsStream, event => setKimiCodeChatCompletionsTier(event, tier));
    const parsed = await parseUpstreamStream(answer.http, scope, decode, formatOpenAIError, MAX_KIMI_CODE_ERROR_BODY_BYTES);
    return { ...answer, ...usageModel, http: parsed.http, openaiChatCompletions: parsed.outcome };
  },
});
