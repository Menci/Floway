import { compressInlineImages } from '../anthropic-messages/compress-images/shape.ts';
import { defineCopilotStage } from '../facts.ts';

export const compressImages = defineCopilotStage({
  name: 'copilot.anthropicMessagesCountTokens.compressImages',
  through: {
    request: { needs: ['anthropicMessagesCountTokens', 'model'], provides: ['anthropicMessagesCountTokens'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const payload = facts.anthropicMessagesCountTokens;
    const updated = await compressInlineImages(payload, facts.model.id, scope.services);
    return await scope.next(updated === payload ? facts : { ...facts, anthropicMessagesCountTokens: updated });
  },
});
