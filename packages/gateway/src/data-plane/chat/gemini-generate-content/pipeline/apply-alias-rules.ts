import { geminiGenerateContentPayload } from './native-target.ts';
import { gatewayFactSpace } from '../../../pipeline/facts.ts';
import { applyRulesToUpstreamGeminiGenerateContent } from '../../shared/alias-rules.ts';
import { move, transform } from '@floway-dev/pipeline';

const { defineStage } = gatewayFactSpace<{}>();
const key = 'request.geminiGenerateContent';

export const applyAliasRules = defineStage({
  name: 'geminiGenerateContent.apply-alias-rules',
  through: {
    request: { needs: [key, 'serve.candidate'], provides: [key], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request: facts => {
      const { rules } = facts['serve.candidate'];
      if (rules === undefined) return facts;
      const payload = { ...geminiGenerateContentPayload(facts[key]) };
      applyRulesToUpstreamGeminiGenerateContent(payload, rules);
      return { ...facts, [key]: move(payload) };
    },
  })),
});
