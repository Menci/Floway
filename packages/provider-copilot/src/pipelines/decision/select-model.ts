import { selectCopilotRawModel } from '../../model-selection.ts';
import { defineCopilotStage } from '../facts.ts';

export const selectModel = defineCopilotStage({
  name: 'copilot.decision.selectModel',
  through: {
    request: { needs: ['provider.model', 'request.decision'], provides: ['request.decision'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const payload = facts['request.decision'];
    const model = selectCopilotRawModel(facts['provider.model'], 'decision');
    return await scope.next({ ...facts, 'request.decision': { ...payload, raw: { ...payload.raw, model } } });
  },
});
