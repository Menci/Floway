import { rawModelFor } from '../../catalog.ts';
import { defineCopilotStage } from '../facts.ts';

export const selectModel = defineCopilotStage({
  name: 'copilot.openaiImagesGenerations.selectModel',
  through: {
    request: { needs: ['model'], provides: ['copilot.modelId'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const { id } = rawModelFor(facts.model, 'openaiImagesGenerations');
    return await scope.next({ ...facts, 'copilot.modelId': id });
  },
});
