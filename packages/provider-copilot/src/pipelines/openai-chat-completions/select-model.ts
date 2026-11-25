import { defineCopilotStage } from '../facts.ts';

export const selectOpenAIChatCompletionsModel = defineCopilotStage({
  name: 'copilot.openaiChatCompletions.selectModel',
  through: {
    request: { needs: ['request.openaiChatCompletions', 'provider.upstream', 'provider.model'], provides: ['copilot.modelId'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    // Copilot /chat/completions ignores service_tier and reports default even on a priority request.
    // https://github.com/caozhiyuan/copilot-api/commit/f7835a44f06976cab874700e4d94a5f5c0379369
    const { reasoning_effort: effort } = facts['request.openaiChatCompletions'];
    const model = facts['provider.model'].upstreamModelId;
    const selected = await scope.services.copilot.selectModel(facts['provider.upstream'].id, model, 'openaiChatCompletions', {
      reasoningEffort: effort === 'none' ? undefined : effort ?? undefined,
    });
    if (selected.kind !== 'model') throw new TypeError(`Copilot OpenAI Chat Completions unexpectedly rejected Fast Mode for ${model}`);
    return await scope.next({ ...facts, 'copilot.modelId': selected.id });
  },
});
