import { defineStage } from './facts.ts';
import { observePerformance } from '../../pipeline/performance.ts';

export const measurePerformance = defineStage({
  name: 'rerank.measure-performance',
  through: {
    request: { needs: ['model', 'upstream'], provides: [], consumes: [] },
    response: { needs: ['rerank', 'usage'], provides: ['rerank', 'usage'], consumes: [] },
  },
  async execute(facts, scope) {
    const answer = await scope.next(facts);
    const { outcome: rerank, usage } = observePerformance(scope, answer.rerank, answer.usage, {
      operation: 'rerank', upstream: facts.upstream.id, model: facts.model.id,
    });
    return { ...answer, rerank, usage };
  },
});
