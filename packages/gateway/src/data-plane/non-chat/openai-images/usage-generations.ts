import { imageUsageReaders } from './image-usage.ts';
import { observeUsage } from '../../pipeline/compute-usage.ts';
import { defineStage } from '../../pipeline/facts.ts';

export const computeOpenAIImagesGenerationsUsage = defineStage({
  name: 'openaiImagesGenerations.usage',
  through: {
    request: { needs: ['model'], provides: [], consumes: [] },
    response: { needs: ['openaiImagesGenerations', 'usageModelKey?'], provides: ['openaiImagesGenerations', 'usage'], consumes: ['usageModelKey'] },
  },
  async execute(facts, scope) {
    const { model } = facts;
    const { usageModelKey, ...answer } = await scope.next(facts);
    const observed = observeUsage(scope, answer.openaiImagesGenerations, usageModelKey ?? model.upstreamModelId, imageUsageReaders);
    return { ...answer, openaiImagesGenerations: observed.outcome, usage: observed.usage };
  },
});
