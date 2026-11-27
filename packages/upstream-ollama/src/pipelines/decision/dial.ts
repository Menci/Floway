import { defineStage, HTTP_ANSWER, MODEL_ENTRY } from '../facts.ts';
import { dialJson } from '../request.ts';
import { decodeResult, formatOpenAIError } from '../response.ts';
import { DEFAULT_DECISION_PATHS, serializeDecisionRequest } from '@floway-dev/protocols/decision';

export const decision = defineStage({
  name: 'ollama.decision.dial',
  through: {
    request: { needs: [...MODEL_ENTRY, 'decision'], provides: ['http'], consumes: [] },
    response: { needs: HTTP_ANSWER, provides: ['http', 'decision'], consumes: ['http.error'] },
  },
  async execute(facts, scope) {
    const { http, upstream, model } = facts;
    const target = model.decisionTarget;
    // https://docs.ollama.com/capabilities/decision
    if (target?.protocol !== 'typesafe-systemone') throw new Error(`Ollama decision model ${model.id} must use a System One target`);
    const payload = serializeDecisionRequest(target.protocol, model.upstreamModelId, facts.decision);
    const request = dialJson(http, upstream, target.path ?? DEFAULT_DECISION_PATHS[target.protocol], payload);
    const answer = await scope.next({ ...facts, http: request });
    const { outcome, ...response } = await decodeResult(answer, scope, formatOpenAIError, bytes => ({ ok: true, value: bytes }));
    return { ...response, decision: outcome };
  },
});
