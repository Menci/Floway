import { defineStage } from '../../pipeline/facts.ts';
import { applyRulesToUpstreamOpenAIResponses } from '../shared/alias-rules.ts';

export const applyOpenAIResponsesAliasRules = defineStage({
  name: 'openaiResponses.apply-alias-rules',
  through: {
    request: { needs: ['request.openaiResponses', 'request.aliasRules?'], provides: ['request.openaiResponses'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const rules = facts['request.aliasRules'];
    if (rules === undefined) return await scope.next(facts);
    const payload = { ...facts['request.openaiResponses'] };
    applyRulesToUpstreamOpenAIResponses(payload, rules);
    return await scope.next({ ...facts, 'request.openaiResponses': payload });
  },
});
