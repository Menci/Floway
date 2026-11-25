import { openAIResponsesFactSpace } from './facts.ts';
import { applyRulesToUpstreamOpenAIResponses } from '../../shared/alias-rules.ts';
import { move, transform } from '@floway-dev/pipeline';

const { defineStage } = openAIResponsesFactSpace<{}>();

export const applyOpenAIResponsesAliasRules = defineStage({
  name: 'openaiResponses.apply-alias-rules',
  through: {
    request: { needs: ['request.openaiResponses', 'serve.candidate'], provides: ['request.openaiResponses'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request(facts) {
      const { rules } = facts['serve.candidate'];
      if (rules === undefined) return facts;
      const payload = { ...facts['request.openaiResponses'] };
      applyRulesToUpstreamOpenAIResponses(payload, rules);
      return { ...facts, 'request.openaiResponses': move(payload) };
    },
  })),
});
