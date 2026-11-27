import { defineStage } from '../../pipeline/facts.ts';
import { applyRulesToUpstreamOpenAIResponses } from '../../shared/alias-rules.ts';

export const applyOpenAIResponsesAliasRules = defineStage({
  name: 'openaiResponses.apply-alias-rules',
  through: {
    request: { needs: ['openaiResponses', 'aliasRules'], provides: ['openaiResponses'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const payload = { ...facts.openaiResponses };
    applyRulesToUpstreamOpenAIResponses(payload, facts.aliasRules);
    return await scope.next({ ...facts, openaiResponses: payload });
  },
});
