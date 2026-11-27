import { rawModelFor } from '../../catalog.ts';
import { CONTEXT_1M_BETA } from '../../model-selection.ts';
import { callerAnthropicBetas } from '../anthropic-messages/normalize-anthropic-beta.ts';
import { defineCopilotStage } from '../facts.ts';

export const selectModel = defineCopilotStage({
  name: 'copilot.anthropicMessagesCountTokens.selectModel',
  through: {
    request: { needs: ['anthropicMessagesCountTokens', 'model', 'http'], provides: ['copilot.modelId'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const { id } = rawModelFor(facts.model, 'anthropicMessages', {
      context1m: callerAnthropicBetas(facts.http.headers).includes(CONTEXT_1M_BETA),
      reasoningEffort: facts.anthropicMessagesCountTokens.output_config?.effort ?? undefined,
    });
    return await scope.next({ ...facts, 'copilot.modelId': id });
  },
});
