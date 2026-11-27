import { defineStage } from '../../pipeline/facts.ts';
import { applyRulesToUpstreamOpenAIChatCompletions } from '../../shared/alias-rules.ts';

export const applyOpenAIChatCompletionsAliasRules = defineStage({
  name: 'openaiChatCompletions.apply-alias-rules',
  through: {
    request: { needs: ['openaiChatCompletions', 'aliasRules'], provides: ['openaiChatCompletions'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const payload = { ...facts.openaiChatCompletions };
    applyRulesToUpstreamOpenAIChatCompletions(payload, facts.aliasRules);
    return await scope.next({ ...facts, openaiChatCompletions: payload });
  },
});
