import { defineStage } from '../../pipeline/facts.ts';
import { observePerformance } from '../../pipeline/performance.ts';

export const measurePerformance = defineStage({
  name: 'alphaSearch.measure-performance',
  through: {
    request: { needs: ['model', 'upstream'], provides: [], consumes: [] },
    response: { needs: ['alphaSearch', 'usage'], provides: ['alphaSearch', 'usage'], consumes: [] },
  },
  async execute(facts, scope) {
    const answer = await scope.next(facts);
    const { outcome: alphaSearch, usage } = observePerformance(scope, answer.alphaSearch, answer.usage, {
      operation: 'alpha_search', upstream: facts.upstream.id, model: facts.model.id,
    });
    return { ...answer, alphaSearch, usage };
  },
});
