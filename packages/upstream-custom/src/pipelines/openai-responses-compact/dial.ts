import { TEXT_RESULT_BODY_BYTES, customModelRequest, customResult, decodeJson, defineStage, dialResponseConsumes, dialResponseNeeds } from '../http.ts';
import { decodeOpenAIResponsesCompactionResult, toCompactPayloadShape } from '@floway-dev/protocols/openai-responses';

export const openaiResponsesCompactDial = defineStage({
  name: 'custom.openaiResponsesCompact.dial',
  through: {
    request: { needs: ['http', 'upstream', 'model', 'openaiResponsesCompact'], provides: ['http'], consumes: [] },
    response: { needs: dialResponseNeeds, provides: ['http', 'openaiResponsesCompact'], consumes: dialResponseConsumes },
  },
  async execute(facts, scope) {
    const { http, upstream, model, openaiResponsesCompact } = facts;
    const request = customModelRequest(http, upstream, '/responses', model.upstreamModelId, toCompactPayloadShape(openaiResponsesCompact), 'bearer', '/compact');
    const answer = await scope.next({ ...facts, http: request });
    const parsed = await customResult(answer, scope, decodeJson(decodeOpenAIResponsesCompactionResult), TEXT_RESULT_BODY_BYTES);
    return { http: parsed.http, openaiResponsesCompact: parsed.outcome };
  },
});
