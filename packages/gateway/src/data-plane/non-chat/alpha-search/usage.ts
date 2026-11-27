import { observeUsage } from '../../pipeline/compute-usage.ts';
import { defineStage } from '../../pipeline/facts.ts';

export const computeUsage = defineStage({
  name: 'alphaSearch.compute-usage',
  through: {
    request: { needs: ['model'], provides: [], consumes: [] },
    response: { needs: ['alphaSearch'], provides: ['alphaSearch', 'usage'], consumes: [] },
  },
  async execute(facts, scope) {
    const answer = await scope.next(facts);
    const { outcome: alphaSearch, usage } = observeUsage(scope, answer.alphaSearch, facts.model.upstreamModelId, { result: () => [] });
    return { ...answer, alphaSearch, usage };
  },
});
