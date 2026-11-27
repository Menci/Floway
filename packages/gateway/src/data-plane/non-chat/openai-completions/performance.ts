import { defineStage } from '../../pipeline/facts.ts';
import { observePerformance } from '../../pipeline/performance.ts';

export const measureOpenAICompletionsPerformance = defineStage({
  name: 'openaiCompletions.performance',
  through: {
    request: { needs: ['upstream', 'model'], provides: [], consumes: [] },
    response: { needs: ['openaiCompletions', 'usage'], provides: ['openaiCompletions', 'usage'], consumes: [] },
  },
  async execute(facts, scope) {
    const answer = await scope.next(facts);
    const measured = observePerformance(scope, answer.openaiCompletions, answer.usage, {
      operation: 'text_completion',
      upstream: facts.upstream.id,
      model: facts.model.id,
    });
    return { ...answer, openaiCompletions: measured.outcome, usage: measured.usage };
  },
});
