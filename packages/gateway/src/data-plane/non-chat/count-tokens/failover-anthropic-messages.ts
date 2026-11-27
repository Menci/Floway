import { defineStage } from './facts.ts';
import { selectCandidate } from '../../pipeline/failover.ts';

export const failoverAnthropicMessagesCountTokens = defineStage({
  name: 'anthropicMessagesCountTokens.failover',
  through: {
    request: {
      needs: ['anthropicMessagesCountTokensTargets', 'http'],
      provides: ['upstream', 'model', 'aliasRules', 'anthropicMessagesCountTokens'],
      consumes: ['anthropicMessagesCountTokensTargets'],
    },
    response: { needs: ['http', 'anthropicMessagesCountTokens'], provides: ['candidate'], consumes: [] },
  },
  async execute({ anthropicMessagesCountTokensTargets, ...facts }, scope) {
    return await selectCandidate(anthropicMessagesCountTokensTargets, scope, ({ upstream, model, rules, payload }) =>
      scope.next({ ...facts, upstream, model, aliasRules: rules ?? {}, anthropicMessagesCountTokens: payload }),
    answer => answer.anthropicMessagesCountTokens);
  },
});
