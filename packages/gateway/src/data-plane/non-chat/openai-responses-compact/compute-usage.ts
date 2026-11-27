import { defineStage } from './facts.ts';
import { billableUsageFromOpenAIResponsesResult } from '../../chat/openai-responses/usage.ts';
import { observeUsage } from '../../pipeline/compute-usage.ts';
import { tokenUsageFromBillableUsage, tokenUsageMeasurement } from '../../shared/telemetry/usage.ts';

export const computeOpenAIResponsesCompactUsage = defineStage({
  name: 'openaiResponsesCompact.compute-usage',
  through: {
    request: { needs: ['model'], provides: [], consumes: [] },
    response: { needs: ['openaiResponsesCompact', 'usageModelKey?'], provides: ['usage'], consumes: ['usageModelKey'] },
  },
  async execute(facts, scope) {
    const { openaiResponsesCompact: outcome, usageModelKey, ...answer } = await scope.next(facts);
    const { usage } = observeUsage(scope, outcome, usageModelKey ?? facts.model.upstreamModelId, {
      result: result => [tokenUsageMeasurement(tokenUsageFromBillableUsage(billableUsageFromOpenAIResponsesResult(result) ?? undefined))],
    });
    return { ...answer, openaiResponsesCompact: outcome, usage };
  },
});
