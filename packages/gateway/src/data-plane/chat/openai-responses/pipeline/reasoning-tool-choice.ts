import { defineStage } from '../../pipeline/facts.ts';

export const disableOpenAIResponsesReasoningOnForcedToolChoice = defineStage({
  name: 'openaiResponses.disable-reasoning-on-forced-tool-choice',
  through: {
    request: { needs: ['openaiResponses', 'model'], provides: ['openaiResponses'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const payload = facts.openaiResponses;
    const choice = payload.tool_choice;
    const forced = choice === 'required' || (choice !== null && typeof choice === 'object');
    if (!forced || !facts.model.enabledFlags.includes('disable-reasoning-on-forced-tool-choice')) return await scope.next(facts);
    return await scope.next({ ...facts, openaiResponses: { ...payload, reasoning: { effort: 'none' } } });
  },
});
