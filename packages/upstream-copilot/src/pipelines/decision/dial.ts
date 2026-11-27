import { defineCopilotStage } from '../facts.ts';
import { formatOpenAIError } from '../shared/format-errors.ts';
import { dispatchedAnswer, jsonRequest } from '../shared/wire-request.ts';
import { DEFAULT_DECISION_PATHS, serializeDecisionRequest } from '@floway-dev/protocols/decision';
import { httpDialError } from '@floway-dev/upstream';

export const dial = defineCopilotStage({
  name: 'copilot.decision.dial',
  through: {
    request: { needs: ['http', 'decision', 'copilot.modelId', 'model'], provides: ['http'], consumes: ['copilot.modelId'] },
    response: { needs: ['http', 'http.error?'], provides: ['decision?', 'usageModelKey?'], consumes: ['http.error'] },
  },
  async execute(facts, scope) {
    const { 'copilot.modelId': modelId, ...request } = facts;
    const target = facts.model.decisionTarget;
    if (target === undefined) throw new Error(`Copilot decision model ${facts.model.id} has no outbound target`);
    const body = serializeDecisionRequest(target.protocol, modelId, facts.decision);
    const http = jsonRequest(facts.http, target.path ?? DEFAULT_DECISION_PATHS[target.protocol], body);
    const { failure, answer } = dispatchedAnswer(await scope.next({ ...request, http }), modelId, facts.model.upstreamModelId);
    return failure === undefined ? answer : { ...answer, decision: httpDialError(failure, formatOpenAIError) };
  },
});
