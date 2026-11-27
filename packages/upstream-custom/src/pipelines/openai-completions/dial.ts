import { TEXT_RESULT_BODY_BYTES, customModelRequest, customResult, customStream, decodeJson, defineStage, dialResponseConsumes, dialResponseNeeds } from '../http.ts';
import { decodeOpenAICompletionsResult, decodeOpenAICompletionsStream } from '@floway-dev/protocols/openai-completions';

export const openaiCompletionsDial = defineStage({
  name: 'custom.openaiCompletions.dial',
  through: {
    request: { needs: ['http', 'upstream', 'model', 'openaiCompletions'], provides: ['http'], consumes: [] },
    response: { needs: dialResponseNeeds, provides: ['http', 'openaiCompletions'], consumes: dialResponseConsumes },
  },
  async execute(facts, scope) {
    const { http, upstream, model, openaiCompletions } = facts;
    const request = customModelRequest(http, upstream, '/completions', model.upstreamModelId, openaiCompletions);
    const answer = await scope.next({ ...facts, http: request });
    const parsed = openaiCompletions.stream === true
      ? await customStream(answer, scope, decodeOpenAICompletionsStream)
      : await customResult(answer, scope, decodeJson(decodeOpenAICompletionsResult), TEXT_RESULT_BODY_BYTES);
    return { http: parsed.http, openaiCompletions: parsed.outcome };
  },
});
