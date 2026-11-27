import { defineStage } from './facts.ts';
import { observePerformance } from '../../pipeline/performance.ts';

export const measureGeminiGenerateContentCountTokensPerformance = defineStage({
  name: 'geminiGenerateContentCountTokens.measure-performance',
  through: {
    request: { needs: ['upstream', 'model'], provides: [], consumes: [] },
    response: { needs: ['geminiGenerateContentCountTokens', 'usage'], provides: ['usage'], consumes: [] },
  },
  async execute(facts, scope) {
    const answer = await scope.next(facts);
    const { usage } = observePerformance(scope, answer.geminiGenerateContentCountTokens, answer.usage, {
      operation: 'count_tokens', upstream: facts.upstream.id, model: facts.model.id,
    });
    return { ...answer, usage };
  },
});
