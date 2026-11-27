import { defineCopilotStage } from '../facts.ts';
import { stripImageGenerationFromPayload } from './strip-image-generation/shape.ts';

export const stripImageGeneration = defineCopilotStage({
  name: 'copilot.openaiResponses.stripImageGeneration',
  through: {
    request: { needs: ['openaiResponses'], provides: ['openaiResponses'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const payload = facts.openaiResponses;
    const updated = stripImageGenerationFromPayload(payload);
    return await scope.next(updated === payload ? facts : { ...facts, openaiResponses: updated });
  },
});
