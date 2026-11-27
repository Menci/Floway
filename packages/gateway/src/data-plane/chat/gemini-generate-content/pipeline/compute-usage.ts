import { observeUsage } from '../../../pipeline/compute-usage.ts';
import { defineStage } from '../../pipeline/facts.ts';
import { chatUsageReader } from '../../pipeline/usage-reader.ts';
import { billableUsageFromGeminiGenerateContentEvent } from '@floway-dev/protocols/gemini-generate-content';

const reader = chatUsageReader(() => billableUsageFromGeminiGenerateContentEvent, () => false);

export const computeGeminiGenerateContentUsage = defineStage({
  name: 'geminiGenerateContent.compute-usage',
  through: {
    request: { needs: ['model'], provides: [], consumes: [] },
    response: { needs: ['geminiGenerateContent', 'usageModelKey?'], provides: ['geminiGenerateContent', 'usage'], consumes: [] },
  },
  async execute(facts, scope) {
    const answer = await scope.next(facts);
    const outcome = answer.geminiGenerateContent;
    if (outcome.kind === 'result') throw new TypeError('Received a collected result in the upstream egress');
    const observed = observeUsage(scope, outcome, answer.usageModelKey ?? facts.model.upstreamModelId, { stream: reader });
    return { ...answer, geminiGenerateContent: observed.outcome, usage: observed.usage };
  },
});
