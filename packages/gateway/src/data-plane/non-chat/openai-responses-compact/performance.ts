import { defineStage } from './facts.ts';
import { observePerformance } from '../../pipeline/performance.ts';

export const measureOpenAIResponsesCompactPerformance = defineStage({
  name: 'openaiResponsesCompact.measure-performance',
  through: {
    request: { needs: ['upstream', 'model'], provides: [], consumes: [] },
    response: { needs: ['openaiResponsesCompact', 'usage'], provides: ['usage'], consumes: [] },
  },
  async execute(facts, scope) {
    const answer = await scope.next(facts);
    const { usage } = observePerformance(scope, answer.openaiResponsesCompact, answer.usage, {
      operation: 'chat', upstream: facts.upstream.id, model: facts.model.id,
    });
    return { ...answer, usage };
  },
});
