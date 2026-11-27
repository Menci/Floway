import { defineCopilotStage } from '../facts.ts';
import { stripImageGenerationFromPayload } from '../openai-responses/strip-image-generation/shape.ts';

export const stripImageGeneration = defineCopilotStage({
  name: 'copilot.openaiResponsesCompact.stripImageGeneration',
  through: {
    request: { needs: ['openaiResponsesCompact'], provides: ['openaiResponsesCompact'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const payload = facts.openaiResponsesCompact;
    const updated = stripImageGenerationFromPayload(payload);
    return await scope.next(updated === payload ? facts : { ...facts, openaiResponsesCompact: updated });
  },
});
