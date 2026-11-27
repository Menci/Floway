import { rawModelFor } from '../../catalog.ts';
import { defineCopilotStage } from '../facts.ts';
import { isFastServiceTier } from '@floway-dev/protocols/common';

export const selectModel = defineCopilotStage({
  name: 'copilot.openaiResponses.selectModel',
  through: {
    request: { needs: ['openaiResponses', 'model'], provides: ['copilot.modelId'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const { id } = rawModelFor(facts.model, 'openaiResponses', {
      reasoningEffort: facts.openaiResponses.reasoning?.effort === 'none' ? undefined : facts.openaiResponses.reasoning?.effort ?? undefined,
      fast: isFastServiceTier(facts.openaiResponses.service_tier),
    });
    return await scope.next({ ...facts, 'copilot.modelId': id });
  },
});
