import { customModelRequest, customStream, defineStage, dialResponseConsumes, dialResponseNeeds } from '../http.ts';
import { normalizeResponsesRequest } from '../vendor-chat.ts';
import { decodeOpenAIResponsesStream } from '@floway-dev/protocols/openai-responses';

export const openaiResponsesDial = defineStage({
  name: 'custom.openaiResponses.dial',
  through: {
    request: { needs: ['http', 'upstream', 'model', 'openaiResponses'], provides: ['http'], consumes: [] },
    response: { needs: dialResponseNeeds, provides: ['http', 'openaiResponses'], consumes: dialResponseConsumes },
  },
  async execute(facts, scope) {
    const { http, upstream, model, openaiResponses } = facts;
    const payload = normalizeResponsesRequest(openaiResponses, model.enabledFlags);
    const request = customModelRequest(http, upstream, '/responses', model.upstreamModelId, { ...payload, stream: true });
    const answer = await scope.next({ ...facts, http: request });
    const parsed = await customStream(answer, scope, decodeOpenAIResponsesStream);
    return { http: parsed.http, openaiResponses: parsed.outcome };
  },
});
