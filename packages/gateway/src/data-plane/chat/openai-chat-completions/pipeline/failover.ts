import { selectCandidate } from '../../../pipeline/failover.ts';
import { defineStage } from '../../pipeline/facts.ts';

export const failoverOpenAIChatCompletions = defineStage({
  name: 'openaiChatCompletions.failover',
  through: {
    request: {
      needs: ['openaiChatCompletions', 'chat.targets.openaiChatCompletions'],
      provides: ['upstream', 'model', 'aliasRules', 'chat.target', 'openaiChatCompletions'],
      consumes: ['chat.targets.openaiChatCompletions'],
    },
    response: {
      needs: ['http', 'openaiChatCompletions', 'usage?', 'usageModelKey?'],
      provides: ['candidate'],
      consumes: ['usageModelKey'],
    },
  },
  async execute(facts, scope) {
    const { 'chat.targets.openaiChatCompletions': targets, ...request } = facts;
    const { usageModelKey: _usageModelKey, ...answer } = await selectCandidate(targets, scope, target => scope.next({
      ...request,
      upstream: target.upstream,
      model: target.model,
      aliasRules: target.rules ?? {},
      'chat.target': target.operation,
      openaiChatCompletions: target.payload,
    }), response => response.openaiChatCompletions);
    const outcome = answer.openaiChatCompletions;
    if (outcome.kind === 'error') scope.services.dump?.selectUpstreamTranslationError(outcome);
    return answer;
  },
});
