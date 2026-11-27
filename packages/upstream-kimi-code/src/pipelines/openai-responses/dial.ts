import { selectKimiCodeOpenAIModel } from '../../model-selection.ts';
import { setKimiCodeResponsesTier } from '../../speed.ts';
import { defineStage } from '../facts.ts';
import { prepareKimiCodeRequest } from '../request.ts';
import { formatOpenAIError, invalidSpeed, mapProtocolEvents, MAX_KIMI_CODE_ERROR_BODY_BYTES } from '../response.ts';
import { decodeOpenAIResponsesStream } from '@floway-dev/protocols/openai-responses';
import { httpDialError, parseUpstreamStream } from '@floway-dev/upstream';

export const dialOpenAIResponses = defineStage({
  name: 'kimi-code.openaiResponses.dial',
  through: {
    request: { needs: ['http', 'upstream', 'model', 'openaiResponses'], provides: ['http'], consumes: [] },
    response: { needs: ['http', 'http.error?'], provides: ['http', 'openaiResponses', 'usageModelKey?'], consumes: ['http.error'] },
  },
  return: { provides: ['http', 'openaiResponses'] },
  async execute(facts, scope) {
    const { http, model, openaiResponses: payload, upstream } = facts;
    const selection = selectKimiCodeOpenAIModel(model, payload.service_tier);
    if (!selection.ok) {
      const { http, outcome } = invalidSpeed(selection.error, formatOpenAIError);
      return { http, openaiResponses: outcome };
    }
    const { modelId, tier } = selection.value;
    const usageModel = modelId === model.upstreamModelId ? {} : { usageModelKey: modelId };
    const body = { ...payload, ...(tier !== undefined && { service_tier: tier }), model: modelId, stream: true };
    const { 'http.error': failure, ...answer } = await scope.next({ ...facts, http: prepareKimiCodeRequest(http, upstream, '/responses', body) });
    if (failure !== undefined) {
      return { ...answer, ...(failure.kind !== 'abort' && usageModel), openaiResponses: httpDialError(failure, formatOpenAIError) };
    }
    if (answer.http === null) throw new Error('Expected Kimi Code HTTP response headers or a dial error');
    const decode = tier === undefined ? decodeOpenAIResponsesStream : mapProtocolEvents(decodeOpenAIResponsesStream, event => setKimiCodeResponsesTier(event, tier));
    const parsed = await parseUpstreamStream(answer.http, scope, decode, formatOpenAIError, MAX_KIMI_CODE_ERROR_BODY_BYTES);
    return { ...answer, ...usageModel, http: parsed.http, openaiResponses: parsed.outcome };
  },
});
