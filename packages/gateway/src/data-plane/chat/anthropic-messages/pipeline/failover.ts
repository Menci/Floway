import { selectCandidate } from '../../../pipeline/failover.ts';
import { defineStage } from '../../pipeline/facts.ts';

export const failoverAnthropicMessages = defineStage({
  name: 'anthropicMessages.failover',
  through: {
    request: {
      needs: ['anthropicMessages', 'chat.targets.anthropicMessages'],
      provides: ['upstream', 'model', 'aliasRules', 'chat.target', 'anthropicMessages'],
      consumes: ['chat.targets.anthropicMessages'],
    },
    response: {
      needs: ['http', 'anthropicMessages', 'usage?', 'usageModelKey?'],
      provides: ['candidate'],
      consumes: ['usageModelKey'],
    },
  },
  async execute(facts, scope) {
    const { 'chat.targets.anthropicMessages': targets, ...request } = facts;
    const { usageModelKey: _usageModelKey, ...answer } = await selectCandidate(targets, scope, target => scope.next({
      ...request,
      upstream: target.upstream,
      model: target.model,
      aliasRules: target.rules ?? {},
      'chat.target': target.operation,
      anthropicMessages: target.payload,
    }), response => response.anthropicMessages);
    const outcome = answer.anthropicMessages;
    if (outcome.kind === 'error') scope.services.dump?.selectUpstreamTranslationError(outcome);
    return answer;
  },
});
