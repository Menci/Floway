import { defineStage } from '../../pipeline/facts.ts';
import { observePerformance } from '../../pipeline/performance.ts';

export const measureOpenAIEmbeddingsPerformance = defineStage({
  name: 'openaiEmbeddings.performance',
  through: {
    request: { needs: ['upstream', 'model'], provides: [], consumes: [] },
    response: { needs: ['openaiEmbeddings', 'usage'], provides: ['openaiEmbeddings', 'usage'], consumes: [] },
  },
  async execute(facts, scope) {
    const answer = await scope.next(facts);
    const measured = observePerformance(scope, answer.openaiEmbeddings, answer.usage, {
      operation: 'embeddings',
      upstream: facts.upstream.id,
      model: facts.model.id,
    });
    return { ...answer, openaiEmbeddings: measured.outcome, usage: measured.usage };
  },
});
