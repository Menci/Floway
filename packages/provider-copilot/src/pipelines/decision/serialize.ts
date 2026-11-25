import { defineCopilotStage } from '../facts.ts';
import { decisionTarget } from './target.ts';
import { serializeJsonRequest } from '../shared/json.ts';
import { transform } from '@floway-dev/pipeline';
import { DEFAULT_DECISION_PATHS, serializeDecisionRequest } from '@floway-dev/protocols/decision';

export const serializeDecision = defineCopilotStage({
  name: 'copilot.decision.serialize',
  through: {
    request: { needs: ['request.decision', 'request.http', 'provider.model', 'copilot.modelId'], provides: ['request.http'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request(facts) {
      const target = decisionTarget(facts['provider.model']);
      const body = serializeDecisionRequest(target.protocol, facts['copilot.modelId'], facts['request.decision']);
      const path = target.path ?? DEFAULT_DECISION_PATHS[target.protocol];
      return { ...facts, 'request.http': serializeJsonRequest(facts['request.http'], path, body) };
    },
  })),
});
