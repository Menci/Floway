import { defineCopilotStage } from '../facts.ts';
import { formatOpenAIError } from '../shared/format-errors.ts';
import { dispatchedAnswer, jsonRequest, wireRequest } from '../shared/wire-request.ts';
import { DEFAULT_DECISION_PATHS, serializeDecisionRequest } from '@floway-dev/protocols/decision';
import { httpDialError, type ProviderModelFact } from '@floway-dev/provider';

export const dial = defineCopilotStage({
  name: 'copilot.decision.dial',
  through: {
    request: { needs: ['request.http', 'request.decision', 'provider.model'], provides: ['request.http'], consumes: [] },
    response: { needs: ['response.http', 'response.http.error?'], provides: ['response.decision?', 'response.usageModelKey?'], consumes: ['response.http.error'] },
  },
  async execute(facts, scope) {
    const payload = facts['request.decision'];
    const target = decisionTarget(facts['provider.model']);
    const modelId = payload.raw.model;
    if (typeof modelId !== 'string') throw new TypeError('Copilot Decision requires a selected model');
    const outbound = jsonRequest(target.path ?? DEFAULT_DECISION_PATHS[target.protocol], serializeDecisionRequest(target.protocol, modelId, payload));
    const http = wireRequest(facts['request.http'], outbound);
    const { failure, answer } = dispatchedAnswer(await scope.next({ ...facts, 'request.http': http }), outbound);
    return failure === undefined ? answer : { ...answer, 'response.decision': httpDialError(failure, formatOpenAIError) };
  },
});

export const decisionTarget = (model: ProviderModelFact) => {
  if (model.decisionTarget === undefined) throw new Error(`Copilot decision model ${model.id} has no outbound target`);
  return model.decisionTarget;
};
