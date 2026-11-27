import { rawModelFor } from '../../catalog.ts';
import { defineCopilotStage } from '../facts.ts';

export const selectModel = defineCopilotStage({
  name: 'copilot.openaiChatCompletions.selectModel',
  through: {
    request: { needs: ['openaiChatCompletions', 'model'], provides: ['copilot.modelId'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const { id } = rawModelFor(facts.model, 'openaiChatCompletions', { reasoningEffort: facts.openaiChatCompletions.reasoning_effort === 'none' ? undefined : facts.openaiChatCompletions.reasoning_effort ?? undefined });
    return await scope.next({ ...facts, 'copilot.modelId': id });
  },
});
