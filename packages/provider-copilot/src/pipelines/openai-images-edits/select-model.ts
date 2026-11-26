import { selectCopilotRawModel } from '../../model-selection.ts';
import { defineCopilotStage } from '../facts.ts';

export const selectModel = defineCopilotStage({
  name: 'copilot.openaiImagesEdits.selectModel',
  through: {
    request: { needs: ['provider.model', 'request.openaiImagesEdits'], provides: ['request.openaiImagesEdits'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const payload = facts['request.openaiImagesEdits'];
    const model = selectCopilotRawModel(facts['provider.model'], 'openaiImagesEdits');
    return await scope.next({ ...facts, 'request.openaiImagesEdits': { ...payload, parameters: { ...payload.parameters, model } } });
  },
});
