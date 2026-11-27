import { selectCandidate } from '../../../pipeline/failover.ts';
import { defineStage } from '../../pipeline/facts.ts';

export const failoverOpenAIResponses = defineStage({
  name: 'openaiResponses.failover',
  through: {
    request: {
      needs: ['openaiResponses', 'chat.targets.openaiResponses'],
      provides: ['upstream', 'model', 'aliasRules', 'chat.target', 'openaiResponses'],
      consumes: ['chat.targets.openaiResponses'],
    },
    response: {
      needs: ['http', 'openaiResponses', 'usage?', 'usageModelKey?'],
      provides: ['candidate'],
      consumes: ['usageModelKey'],
    },
  },
  async execute(facts, scope) {
    const { 'chat.targets.openaiResponses': targets, ...request } = facts;
    const { usageModelKey: _usageModelKey, ...answer } = await selectCandidate(targets, scope, target => scope.next({
      ...request,
      upstream: target.upstream,
      model: target.model,
      aliasRules: target.rules ?? {},
      'chat.target': target.operation,
      openaiResponses: target.payload,
    }), response => response.openaiResponses);
    const outcome = answer.openaiResponses;
    if (outcome.kind === 'error') scope.services.dump?.selectUpstreamTranslationError(outcome);
    return answer;
  },
});
