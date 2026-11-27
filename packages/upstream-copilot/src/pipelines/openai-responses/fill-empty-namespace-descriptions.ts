import { defineCopilotStage } from '../facts.ts';
import { fillDescriptions } from './fill-empty-namespace-descriptions/shape.ts';

export const fillEmptyNamespaceDescriptions = defineCopilotStage({
  name: 'copilot.openaiResponses.fillEmptyNamespaceDescriptions',
  through: {
    request: { needs: ['openaiResponses'], provides: ['openaiResponses'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const payload = facts.openaiResponses;
    const updated = fillDescriptions(payload);
    return await scope.next(updated === payload ? facts : { ...facts, openaiResponses: updated });
  },
});
