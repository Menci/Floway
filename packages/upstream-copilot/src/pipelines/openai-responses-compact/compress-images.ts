import { defineCopilotStage } from '../facts.ts';
import { compressInlineImages } from '../openai-responses/compress-images/shape.ts';

export const compressImages = defineCopilotStage({
  name: 'copilot.openaiResponsesCompact.compressImages',
  through: {
    request: { needs: ['openaiResponsesCompact', 'model'], provides: ['openaiResponsesCompact'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const payload = facts.openaiResponsesCompact;
    const updated = await compressInlineImages(payload, facts.model.id, scope.services);
    return await scope.next(updated === payload ? facts : { ...facts, openaiResponsesCompact: updated });
  },
});
