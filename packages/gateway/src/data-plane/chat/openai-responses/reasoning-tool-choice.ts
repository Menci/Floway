import { defineStage } from '../../pipeline/facts.ts';

export const disableOpenAIResponsesReasoningOnForcedToolChoice = defineStage({
  name: 'openaiResponses.disable-reasoning-on-forced-tool-choice',
  through: {
    request: { needs: ['request.openaiResponses', 'provider.model'], provides: ['request.openaiResponses'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const payload = facts['request.openaiResponses'];
    const choice = payload.tool_choice;
    const forced = choice === 'required' || (choice !== null && typeof choice === 'object');
    if (!forced || !facts['provider.model'].enabledFlags.includes('disable-reasoning-on-forced-tool-choice')) {
      return await scope.next(facts);
    }
    return await scope.next({
      ...facts,
      'request.openaiResponses': { ...payload, reasoning: { effort: 'none' } },
    });
  },
});
