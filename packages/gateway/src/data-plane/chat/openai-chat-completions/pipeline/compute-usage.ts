import { observeUsage } from '../../../pipeline/compute-usage.ts';
import { defineStage } from '../../pipeline/facts.ts';
import { chatUsageReader } from '../../pipeline/usage-reader.ts';
import { billableUsageFromOpenAIChatCompletionsEvent } from '../usage.ts';

const reader = chatUsageReader(() => billableUsageFromOpenAIChatCompletionsEvent, event => event.usage != null && event.choices.length === 0);

export const computeOpenAIChatCompletionsUsage = defineStage({
  name: 'openaiChatCompletions.compute-usage',
  through: {
    request: { needs: ['model'], provides: [], consumes: [] },
    response: { needs: ['openaiChatCompletions', 'usageModelKey?'], provides: ['openaiChatCompletions', 'usage'], consumes: [] },
  },
  async execute(facts, scope) {
    const answer = await scope.next(facts);
    const outcome = answer.openaiChatCompletions;
    if (outcome.kind === 'result') throw new TypeError('Received a collected result in the upstream egress');
    const observed = observeUsage(scope, outcome, answer.usageModelKey ?? facts.model.upstreamModelId, { stream: reader });
    return { ...answer, openaiChatCompletions: observed.outcome, usage: observed.usage };
  },
});
