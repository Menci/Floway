import { defineStage } from './facts.ts';
import { observeUsage } from '../../pipeline/compute-usage.ts';

export const computeAnthropicMessagesCountTokensUsage = defineStage({
  name: 'anthropicMessagesCountTokens.compute-usage',
  through: {
    request: { needs: [], provides: [], consumes: [] },
    response: { needs: ['anthropicMessagesCountTokens', 'usageModelKey?'], provides: ['usage'], consumes: ['usageModelKey'] },
  },
  async execute(facts, scope) {
    const { anthropicMessagesCountTokens: outcome, usageModelKey: _usageModelKey, ...answer } = await scope.next(facts);
    const { usage } = observeUsage(scope, outcome, '', { result: () => [] });
    return { ...answer, anthropicMessagesCountTokens: outcome, usage };
  },
});
