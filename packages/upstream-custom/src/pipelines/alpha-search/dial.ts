import { TEXT_RESULT_BODY_BYTES, customModelRequest, customResult, defineStage, dialResponseConsumes, dialResponseNeeds, keepBytes } from '../http.ts';

export const alphaSearchDial = defineStage({
  name: 'custom.alphaSearch.dial',
  through: {
    request: { needs: ['http', 'upstream', 'model', 'alphaSearch'], provides: ['http'], consumes: [] },
    response: { needs: dialResponseNeeds, provides: ['http', 'alphaSearch'], consumes: dialResponseConsumes },
  },
  async execute(facts, scope) {
    const { http, upstream, model, alphaSearch } = facts;
    const request = customModelRequest(http, upstream, '/alpha/search', model.upstreamModelId, alphaSearch);
    const answer = await scope.next({ ...facts, http: request });
    const parsed = await customResult(answer, scope, keepBytes, TEXT_RESULT_BODY_BYTES);
    return { http: parsed.http, alphaSearch: parsed.outcome };
  },
});
