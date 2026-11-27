import { TEXT_RESULT_BODY_BYTES, customConfig, customJsonRequest, customResult, defineStage, dialResponseConsumes, dialResponseNeeds, keepBytes } from '../http.ts';
import { DEFAULT_RERANK_PATHS, serializeRerankRequest } from '@floway-dev/protocols/rerank';

export const rerankDial = defineStage({
  name: 'custom.rerank.dial',
  through: {
    request: { needs: ['http', 'upstream', 'model', 'rerank'], provides: ['http'], consumes: [] },
    response: { needs: dialResponseNeeds, provides: ['http', 'rerank'], consumes: dialResponseConsumes },
  },
  async execute(facts, scope) {
    const { http, upstream, model, rerank } = facts;
    const target = model.rerankTarget;
    if (target === undefined) throw new Error(`Rerank model ${model.id} has no outbound target`);
    const { protocol, path = DEFAULT_RERANK_PATHS[target.protocol] } = target;
    const body = serializeRerankRequest(protocol, model.upstreamModelId, rerank);
    const request = customJsonRequest(http, customConfig(upstream), path, body);
    const answer = await scope.next({ ...facts, http: request });
    const parsed = await customResult(answer, scope, keepBytes, TEXT_RESULT_BODY_BYTES);
    return { http: parsed.http, rerank: parsed.outcome };
  },
});
