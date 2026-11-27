import { defineStage } from './facts.ts';
import { selectCandidate } from '../../pipeline/failover.ts';

export const failoverOpenAIResponsesCompact = defineStage({
  name: 'openaiResponsesCompact.failover',
  through: {
    request: {
      needs: ['compactTargets', 'http', 'requestedModel', 'serve.startedAt'],
      provides: ['upstream', 'model', 'aliasRules', 'openaiResponsesCompact', 'chat.target'],
      consumes: ['compactTargets'],
    },
    response: { needs: ['http', 'openaiResponsesCompact'], provides: ['candidate'], consumes: [] },
  },
  async execute({ compactTargets, ...facts }, scope) {
    return await selectCandidate(compactTargets, scope, ({ upstream, model, rules, payload, operation }) => scope.next({
      ...facts, upstream, model, aliasRules: rules ?? {}, openaiResponsesCompact: payload, 'chat.target': operation,
    }), answer => answer.openaiResponsesCompact);
  },
});
