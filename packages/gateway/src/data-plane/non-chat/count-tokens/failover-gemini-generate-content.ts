import { defineStage } from './facts.ts';
import { selectCandidate } from '../../pipeline/failover.ts';

export const failoverGeminiGenerateContentCountTokens = defineStage({
  name: 'geminiGenerateContentCountTokens.failover',
  through: {
    request: {
      needs: ['geminiGenerateContentCountTokensTargets', 'http'],
      provides: ['upstream', 'model', 'aliasRules', 'geminiGenerateContentCountTokens'],
      consumes: ['geminiGenerateContentCountTokensTargets'],
    },
    response: { needs: ['http', 'geminiGenerateContentCountTokens'], provides: ['candidate'], consumes: [] },
  },
  async execute({ geminiGenerateContentCountTokensTargets, ...facts }, scope) {
    return await selectCandidate(geminiGenerateContentCountTokensTargets, scope, ({ upstream, model, rules, payload }) =>
      scope.next({ ...facts, upstream, model, aliasRules: rules ?? {}, geminiGenerateContentCountTokens: payload }),
    answer => answer.geminiGenerateContentCountTokens);
  },
});
