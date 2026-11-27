import { defineStage } from '../../pipeline/facts.ts';
import { applyRulesToUpstreamGeminiGenerateContent } from '../../shared/alias-rules.ts';

export const applyGeminiGenerateContentAliasRules = defineStage({
  name: 'geminiGenerateContent.apply-alias-rules',
  through: {
    request: { needs: ['geminiGenerateContent', 'aliasRules'], provides: ['geminiGenerateContent'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const payload = { ...facts.geminiGenerateContent };
    applyRulesToUpstreamGeminiGenerateContent(payload, facts.aliasRules);
    return await scope.next({ ...facts, geminiGenerateContent: payload });
  },
});
