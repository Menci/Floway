import { defineCopilotStage } from '../facts.ts';
import { compressInlineImages } from './compress-images/shape.ts';

export const compressImages = defineCopilotStage({
  name: 'copilot.openaiResponses.compressImages',
  through: {
    request: { needs: ['openaiResponses', 'model'], provides: ['openaiResponses'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const payload = facts.openaiResponses;
    const updated = await compressInlineImages(payload, facts.model.id, scope.services);
    return await scope.next(updated === payload ? facts : { ...facts, openaiResponses: updated });
  },
});
