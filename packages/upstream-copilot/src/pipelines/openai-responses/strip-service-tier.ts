import { defineCopilotStage } from '../facts.ts';
import { withoutServiceTier } from './strip-service-tier/shape.ts';

export const stripServiceTier = defineCopilotStage({
  name: 'copilot.openaiResponses.stripServiceTier',
  through: {
    request: { needs: ['openaiResponses'], provides: ['openaiResponses'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const payload = facts.openaiResponses;
    const updated = withoutServiceTier(payload);
    return await scope.next(updated === payload ? facts : { ...facts, openaiResponses: updated });
  },
});
