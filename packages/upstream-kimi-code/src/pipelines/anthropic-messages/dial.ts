import { selectKimiCodeMessagesModel } from '../../model-selection.ts';
import { kimiCodeMessagesWireBody, setKimiCodeMessagesSpeed } from '../../speed.ts';
import { defineStage } from '../facts.ts';
import { prepareKimiCodeRequest } from '../request.ts';
import { formatAnthropicError, invalidSpeed, mapProtocolEvents, MAX_KIMI_CODE_ERROR_BODY_BYTES } from '../response.ts';
import { decodeAnthropicMessagesStream } from '@floway-dev/protocols/anthropic-messages';
import { httpDialError, parseUpstreamStream } from '@floway-dev/upstream';

export const dialAnthropicMessages = defineStage({
  name: 'kimi-code.anthropicMessages.dial',
  through: {
    request: { needs: ['http', 'upstream', 'model', 'anthropicMessages'], provides: ['http'], consumes: [] },
    response: { needs: ['http', 'http.error?'], provides: ['http', 'anthropicMessages', 'usageModelKey?'], consumes: ['http.error'] },
  },
  return: { provides: ['http', 'anthropicMessages'] },
  async execute(facts, scope) {
    const { http, model, anthropicMessages: payload, upstream } = facts;
    const selection = selectKimiCodeMessagesModel(model, payload.speed);
    if (!selection.ok) {
      const { http, outcome } = invalidSpeed(selection.error, formatAnthropicError);
      return { http, anthropicMessages: outcome };
    }
    const { modelId, speed } = selection.value;
    const usageModel = modelId === model.upstreamModelId ? {} : { usageModelKey: modelId };
    const body = { ...kimiCodeMessagesWireBody(payload), model: modelId, stream: true };
    const { 'http.error': failure, ...answer } = await scope.next({ ...facts, http: prepareKimiCodeRequest(http, upstream, '/messages', body) });
    if (failure !== undefined) {
      return { ...answer, ...(failure.kind !== 'abort' && usageModel), anthropicMessages: httpDialError(failure, formatAnthropicError) };
    }
    if (answer.http === null) throw new Error('Expected Kimi Code HTTP response headers or a dial error');
    const decode = speed === undefined ? decodeAnthropicMessagesStream : mapProtocolEvents(decodeAnthropicMessagesStream, event => setKimiCodeMessagesSpeed(event, speed));
    const parsed = await parseUpstreamStream(answer.http, scope, decode, formatAnthropicError, MAX_KIMI_CODE_ERROR_BODY_BYTES);
    return { ...answer, ...usageModel, http: parsed.http, anthropicMessages: parsed.outcome };
  },
});
