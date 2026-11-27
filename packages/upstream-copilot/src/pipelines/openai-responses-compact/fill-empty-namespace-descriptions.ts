import { defineCopilotStage } from '../facts.ts';
import { fillDescriptions } from '../openai-responses/fill-empty-namespace-descriptions/shape.ts';

export const fillEmptyNamespaceDescriptions = defineCopilotStage({
  name: 'copilot.openaiResponsesCompact.fillEmptyNamespaceDescriptions',
  through: {
    request: { needs: ['openaiResponsesCompact'], provides: ['openaiResponsesCompact'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const payload = facts.openaiResponsesCompact;
    const updated = fillDescriptions(payload);
    return await scope.next(updated === payload ? facts : { ...facts, openaiResponsesCompact: updated });
  },
});
