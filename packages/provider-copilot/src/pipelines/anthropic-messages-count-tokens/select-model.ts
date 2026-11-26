import { CONTEXT_1M_BETA, selectCopilotRawModel } from '../../model-selection.ts';
import { callerAnthropicBetas } from '../anthropic-messages/normalize-anthropic-beta.ts';
import { defineCopilotStage } from '../facts.ts';

export const selectModel = defineCopilotStage({
  name: 'copilot.anthropicMessagesCountTokens.selectModel',
  through: {
    request: { needs: ['provider.model', 'request.http', 'request.anthropicMessagesCountTokens'], provides: ['request.anthropicMessagesCountTokens'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const payload = facts['request.anthropicMessagesCountTokens'];
    const model = selectCopilotRawModel(facts['provider.model'], 'anthropicMessages', {
      context1m: callerAnthropicBetas(facts['request.http'].headers).includes(CONTEXT_1M_BETA),
      reasoningEffort: payload.output_config?.effort ?? undefined,
    });
    return await scope.next({ ...facts, 'request.anthropicMessagesCountTokens': { ...payload, model } });
  },
});
