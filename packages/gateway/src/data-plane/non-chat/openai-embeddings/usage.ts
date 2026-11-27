import { observeUsage } from '../../pipeline/compute-usage.ts';
import { defineStage } from '../../pipeline/facts.ts';
import { requestOnlyUsageMeasurement, tokenUsageMeasurement } from '../../shared/telemetry/usage.ts';
import { isJsonObject } from '@floway-dev/protocols/common';

export const computeOpenAIEmbeddingsUsage = defineStage({
  name: 'openaiEmbeddings.usage',
  through: {
    request: { needs: ['model'], provides: [], consumes: [] },
    response: { needs: ['openaiEmbeddings', 'usageModelKey?'], provides: ['openaiEmbeddings', 'usage'], consumes: ['usageModelKey'] },
  },
  async execute(facts, scope) {
    const { model } = facts;
    const { usageModelKey, ...answer } = await scope.next(facts);
    const observed = observeUsage(scope, answer.openaiEmbeddings, usageModelKey ?? model.upstreamModelId, {
      result({ usage }) {
        const promptTokens = isJsonObject(usage) ? usage.prompt_tokens : undefined;
        return [typeof promptTokens === 'number' ? tokenUsageMeasurement({ input: promptTokens }) : requestOnlyUsageMeasurement()];
      },
    });
    return { ...answer, openaiEmbeddings: observed.outcome, usage: observed.usage };
  },
});
