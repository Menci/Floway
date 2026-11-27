import { defineStage } from './facts.ts';
import { observePerformance } from '../../pipeline/performance.ts';

export const measurePerformance = defineStage({
  name: 'decision.measure-performance',
  through: {
    request: { needs: ['model', 'upstream'], provides: [], consumes: [] },
    response: { needs: ['decision', 'usage'], provides: ['decision', 'usage'], consumes: [] },
  },
  async execute(facts, scope) {
    const answer = await scope.next(facts);
    const { outcome: decision, usage } = observePerformance(scope, answer.decision, answer.usage, {
      operation: 'decision', upstream: facts.upstream.id, model: facts.model.id,
    });
    return { ...answer, decision, usage };
  },
});
