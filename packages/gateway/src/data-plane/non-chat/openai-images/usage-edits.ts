import { imageUsageReaders } from './image-usage.ts';
import { observeUsage } from '../../pipeline/compute-usage.ts';
import { defineStage } from '../../pipeline/facts.ts';

export const computeOpenAIImagesEditsUsage = defineStage({
  name: 'openaiImagesEdits.usage',
  through: {
    request: { needs: ['model'], provides: [], consumes: [] },
    response: { needs: ['openaiImagesEdits', 'usageModelKey?'], provides: ['openaiImagesEdits', 'usage'], consumes: ['usageModelKey'] },
  },
  async execute(facts, scope) {
    const { model } = facts;
    const { usageModelKey, ...answer } = await scope.next(facts);
    const observed = observeUsage(scope, answer.openaiImagesEdits, usageModelKey ?? model.upstreamModelId, imageUsageReaders);
    return { ...answer, openaiImagesEdits: observed.outcome, usage: observed.usage };
  },
});
