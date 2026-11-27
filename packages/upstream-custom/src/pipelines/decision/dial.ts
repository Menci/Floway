import { TEXT_RESULT_BODY_BYTES, customConfig, customJsonRequest, customResult, defineStage, dialResponseConsumes, dialResponseNeeds, keepBytes } from '../http.ts';
import { DEFAULT_DECISION_PATHS, serializeDecisionRequest } from '@floway-dev/protocols/decision';

export const decisionDial = defineStage({
  name: 'custom.decision.dial',
  through: {
    request: { needs: ['http', 'upstream', 'model', 'decision'], provides: ['http'], consumes: [] },
    response: { needs: dialResponseNeeds, provides: ['http', 'decision'], consumes: dialResponseConsumes },
  },
  async execute(facts, scope) {
    const { http, upstream, model, decision } = facts;
    const target = model.decisionTarget;
    if (target === undefined) throw new Error(`Decision model ${model.id} has no outbound target`);
    const { protocol, path = DEFAULT_DECISION_PATHS[target.protocol] } = target;
    const body = serializeDecisionRequest(protocol, model.upstreamModelId, decision);
    const request = customJsonRequest(http, customConfig(upstream), path, body);
    const answer = await scope.next({ ...facts, http: request });
    const parsed = await customResult(answer, scope, keepBytes, TEXT_RESULT_BODY_BYTES);
    return { http: parsed.http, decision: parsed.outcome };
  },
});
