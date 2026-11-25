import { defineCopilotStage } from '../facts.ts';
import { isFastServiceTier } from '@floway-dev/protocols/common';

export const selectOpenAIResponsesModel = defineCopilotStage({
  name: 'copilot.openaiResponses.selectModel',
  through: {
    request: { needs: ['request.openaiResponses', 'provider.upstream', 'provider.model'], provides: ['copilot.modelId'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    // The raw variant selects Fast Mode. The serving lane is reported in the response's service_tier.
    // https://github.com/openai/codex/issues/32191
    // https://github.com/caozhiyuan/copilot-api/commit/f7835a44f06976cab874700e4d94a5f5c0379369
    const request = facts['request.openaiResponses'];
    const reasoning = 'reasoning' in request ? request.reasoning : undefined;
    const model = facts['provider.model'].upstreamModelId;
    const selected = await scope.services.copilot.selectModel(facts['provider.upstream'].id, model, 'openaiResponses', {
      reasoningEffort: reasoning?.effort === 'none' ? undefined : reasoning?.effort ?? undefined,
      fast: isFastServiceTier(request.service_tier),
    });
    if (selected.kind !== 'model') throw new TypeError(`Copilot OpenAI Responses unexpectedly rejected Fast Mode for ${model}`);
    return await scope.next({ ...facts, 'copilot.modelId': selected.id });
  },
});
