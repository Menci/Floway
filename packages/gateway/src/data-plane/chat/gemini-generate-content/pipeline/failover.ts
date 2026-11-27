import { selectCandidate } from '../../../pipeline/failover.ts';
import { defineStage } from '../../pipeline/facts.ts';

export const failoverGeminiGenerateContent = defineStage({
  name: 'geminiGenerateContent.failover',
  through: {
    request: {
      needs: ['geminiGenerateContent', 'chat.targets.geminiGenerateContent'],
      provides: ['upstream', 'model', 'aliasRules', 'chat.target', 'geminiGenerateContent'],
      consumes: ['chat.targets.geminiGenerateContent'],
    },
    response: {
      needs: ['http', 'geminiGenerateContent', 'usage?', 'usageModelKey?'],
      provides: ['candidate'],
      consumes: ['usageModelKey'],
    },
  },
  async execute(facts, scope) {
    const { 'chat.targets.geminiGenerateContent': targets, ...request } = facts;
    const { usageModelKey: _usageModelKey, ...answer } = await selectCandidate(targets, scope, target => scope.next({
      ...request,
      upstream: target.upstream,
      model: target.model,
      aliasRules: target.rules ?? {},
      'chat.target': target.operation,
      geminiGenerateContent: target.payload,
    }), response => response.geminiGenerateContent);
    const outcome = answer.geminiGenerateContent;
    if (outcome.kind === 'error') scope.services.dump?.selectUpstreamTranslationError(outcome);
    return answer;
  },
});
