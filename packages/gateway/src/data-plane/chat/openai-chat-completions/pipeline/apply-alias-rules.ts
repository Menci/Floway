import { gatewayFactSpace } from '../../../pipeline/facts.ts';
import { applyRulesToUpstreamOpenAIChatCompletions } from '../../shared/alias-rules.ts';
import { move, transform } from '@floway-dev/pipeline';

const { defineStage } = gatewayFactSpace<{}>();
const key = 'request.openaiChatCompletions';

export const applyAliasRules = defineStage({
  name: 'openaiChatCompletions.apply-alias-rules',
  through: {
    request: { needs: [key, 'serve.candidate'], provides: [key], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request: facts => {
      const { rules } = facts['serve.candidate'];
      if (rules === undefined) return facts;
      const payload = { ...facts[key] };
      applyRulesToUpstreamOpenAIChatCompletions(payload, rules);
      return { ...facts, [key]: move(payload) };
    },
  })),
});
