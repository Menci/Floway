import { rawModelFor } from '../../catalog.ts';
import { defineCopilotStage } from '../facts.ts';
import { isFastServiceTier } from '@floway-dev/protocols/common';

export const selectModel = defineCopilotStage({
  name: 'copilot.openaiResponsesCompact.selectModel',
  through: {
    request: { needs: ['openaiResponsesCompact', 'model'], provides: ['copilot.modelId'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const { id } = rawModelFor(facts.model, 'openaiResponses', { fast: isFastServiceTier(facts.openaiResponsesCompact.service_tier) });
    return await scope.next({ ...facts, 'copilot.modelId': id });
  },
});
