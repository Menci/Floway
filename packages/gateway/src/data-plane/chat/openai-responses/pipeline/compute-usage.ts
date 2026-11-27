import { observeUsage } from '../../../pipeline/compute-usage.ts';
import { defineStage } from '../../pipeline/facts.ts';
import { openAIResponsesFailureEvents } from '../../pipeline/stream-error.ts';
import { chatUsageReader } from '../../pipeline/usage-reader.ts';
import { billableUsageFromOpenAIResponsesEvent } from '../usage.ts';
import { isOpenAIResponsesTerminalEvent } from '@floway-dev/protocols/openai-responses';

const reader = chatUsageReader(() => billableUsageFromOpenAIResponsesEvent,
  isOpenAIResponsesTerminalEvent, error => openAIResponsesFailureEvents(error).failed);

export const computeOpenAIResponsesUsage = defineStage({
  name: 'openaiResponses.compute-usage',
  through: {
    request: { needs: ['model'], provides: [], consumes: [] },
    response: { needs: ['openaiResponses', 'usageModelKey?'], provides: ['openaiResponses', 'usage'], consumes: [] },
  },
  async execute(facts, scope) {
    const answer = await scope.next(facts);
    const outcome = answer.openaiResponses;
    if (outcome.kind === 'result') throw new TypeError('Received a collected result in the upstream egress');
    const observed = observeUsage(scope, outcome, answer.usageModelKey ?? facts.model.upstreamModelId, { stream: reader });
    return { ...answer, openaiResponses: observed.outcome, usage: observed.usage };
  },
});
