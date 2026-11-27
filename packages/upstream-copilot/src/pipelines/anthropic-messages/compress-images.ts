import { defineCopilotStage } from '../facts.ts';
import { compressInlineImages } from './compress-images/shape.ts';

export const compressImages = defineCopilotStage({
  name: 'copilot.anthropicMessages.compressImages',
  through: {
    request: { needs: ['anthropicMessages', 'model'], provides: ['anthropicMessages'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const payload = facts.anthropicMessages;
    const updated = await compressInlineImages(payload, facts.model.id, scope.services);
    return await scope.next(updated === payload ? facts : { ...facts, anthropicMessages: updated });
  },
});
