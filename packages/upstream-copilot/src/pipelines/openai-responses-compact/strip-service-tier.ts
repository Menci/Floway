import { defineCopilotStage } from '../facts.ts';
import { withoutServiceTier } from '../openai-responses/strip-service-tier/shape.ts';

export const stripServiceTier = defineCopilotStage({
  name: 'copilot.openaiResponsesCompact.stripServiceTier',
  through: {
    request: { needs: ['openaiResponsesCompact'], provides: ['openaiResponsesCompact'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const payload = facts.openaiResponsesCompact;
    const updated = withoutServiceTier(payload);
    return await scope.next(updated === payload ? facts : { ...facts, openaiResponsesCompact: updated });
  },
});
