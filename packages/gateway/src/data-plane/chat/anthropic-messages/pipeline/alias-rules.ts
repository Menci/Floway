import { defineStage } from '../../pipeline/facts.ts';
import { applyRulesToUpstreamAnthropicMessages } from '../../shared/alias-rules.ts';

export const applyAnthropicMessagesAliasRules = defineStage({
  name: 'anthropicMessages.apply-alias-rules',
  through: {
    request: { needs: ['anthropicMessages', 'aliasRules'], provides: ['anthropicMessages'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const payload = { ...facts.anthropicMessages };
    applyRulesToUpstreamAnthropicMessages(payload, facts.aliasRules);
    return await scope.next({ ...facts, anthropicMessages: payload });
  },
});
