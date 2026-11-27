import { rawModelFor } from '../../catalog.ts';
import { defineCopilotStage } from '../facts.ts';

export const selectModel = defineCopilotStage({
  name: 'copilot.openaiImagesEdits.selectModel',
  through: {
    request: { needs: ['model'], provides: ['copilot.modelId'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const { id } = rawModelFor(facts.model, 'openaiImagesEdits');
    return await scope.next({ ...facts, 'copilot.modelId': id });
  },
});
