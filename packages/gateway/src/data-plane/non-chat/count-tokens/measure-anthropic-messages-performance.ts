import { defineStage } from './facts.ts';
import { observePerformance } from '../../pipeline/performance.ts';

export const measureAnthropicMessagesCountTokensPerformance = defineStage({
  name: 'anthropicMessagesCountTokens.measure-performance',
  through: {
    request: { needs: ['upstream', 'model'], provides: [], consumes: [] },
    response: { needs: ['anthropicMessagesCountTokens', 'usage'], provides: ['usage'], consumes: [] },
  },
  async execute(facts, scope) {
    const answer = await scope.next(facts);
    const { usage } = observePerformance(scope, answer.anthropicMessagesCountTokens, answer.usage, {
      operation: 'count_tokens', upstream: facts.upstream.id, model: facts.model.id,
    });
    return { ...answer, usage };
  },
});
