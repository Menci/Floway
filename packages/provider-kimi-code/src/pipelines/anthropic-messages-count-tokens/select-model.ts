import { defineStage } from '../facts.ts';
import { invalidModel, selectAnthropicModel } from '../select-model.ts';

export const selectModel = defineStage({
  name: 'kimi-code.anthropicMessagesCountTokens.select-model',
  through: {
    request: { needs: ['request.anthropicMessagesCountTokens', 'provider.model'], provides: ['request.anthropicMessagesCountTokens'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  return: { provides: ['response.http', 'response.anthropicMessagesCountTokens'] },
  async execute(facts, scope) {
    const body = facts['request.anthropicMessagesCountTokens'];
    const selection = selectAnthropicModel(facts['provider.model'], body.speed);
    if (!selection.ok) {
      const { http, outcome } = invalidModel(selection.error, true);
      return { 'response.http': http, 'response.anthropicMessagesCountTokens': outcome };
    }
    const { speed: _speed, ...rest } = body;
    return await scope.next({
      ...facts,
      'request.anthropicMessagesCountTokens': {
        ...(selection.value.speed === undefined ? body : rest),
        model: selection.value.modelId,
      },
    });
  },
});
