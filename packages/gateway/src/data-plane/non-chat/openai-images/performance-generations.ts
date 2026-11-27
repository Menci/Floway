import { defineStage } from '../../pipeline/facts.ts';
import { observePerformance } from '../../pipeline/performance.ts';

export const measureOpenAIImagesGenerationsPerformance = defineStage({
  name: 'openaiImagesGenerations.performance',
  through: {
    request: { needs: ['upstream', 'model'], provides: [], consumes: [] },
    response: { needs: ['openaiImagesGenerations', 'usage'], provides: ['openaiImagesGenerations', 'usage'], consumes: [] },
  },
  async execute(facts, scope) {
    const answer = await scope.next(facts);
    const measured = observePerformance(scope, answer.openaiImagesGenerations, answer.usage, {
      operation: 'image_generation',
      upstream: facts.upstream.id,
      model: facts.model.id,
    });
    return { ...answer, openaiImagesGenerations: measured.outcome, usage: measured.usage };
  },
});
