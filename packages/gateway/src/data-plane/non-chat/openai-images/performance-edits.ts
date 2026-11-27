import { defineStage } from '../../pipeline/facts.ts';
import { observePerformance } from '../../pipeline/performance.ts';

export const measureOpenAIImagesEditsPerformance = defineStage({
  name: 'openaiImagesEdits.performance',
  through: {
    request: { needs: ['upstream', 'model'], provides: [], consumes: [] },
    response: { needs: ['openaiImagesEdits', 'usage'], provides: ['openaiImagesEdits', 'usage'], consumes: [] },
  },
  async execute(facts, scope) {
    const answer = await scope.next(facts);
    const measured = observePerformance(scope, answer.openaiImagesEdits, answer.usage, {
      operation: 'image_edit',
      upstream: facts.upstream.id,
      model: facts.model.id,
    });
    return { ...answer, openaiImagesEdits: measured.outcome, usage: measured.usage };
  },
});
