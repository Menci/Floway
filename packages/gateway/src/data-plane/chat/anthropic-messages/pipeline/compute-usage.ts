import { observeUsage } from '../../../pipeline/compute-usage.ts';
import { defineStage } from '../../pipeline/facts.ts';
import { chatUsageReader } from '../../pipeline/usage-reader.ts';
import { createAnthropicMessagesBillableUsageReader } from '../usage.ts';

const reader = chatUsageReader(createAnthropicMessagesBillableUsageReader, event => event.type === 'message_delta' && event.usage !== undefined);

export const computeAnthropicMessagesUsage = defineStage({
  name: 'anthropicMessages.compute-usage',
  through: {
    request: { needs: ['model'], provides: [], consumes: [] },
    response: { needs: ['anthropicMessages', 'usageModelKey?'], provides: ['anthropicMessages', 'usage'], consumes: [] },
  },
  async execute(facts, scope) {
    const answer = await scope.next(facts);
    const outcome = answer.anthropicMessages;
    if (outcome.kind === 'result') throw new TypeError('Received a collected result in the upstream egress');
    const observed = observeUsage(scope, outcome, answer.usageModelKey ?? facts.model.upstreamModelId, { stream: reader });
    return { ...answer, anthropicMessages: observed.outcome, usage: observed.usage };
  },
});
