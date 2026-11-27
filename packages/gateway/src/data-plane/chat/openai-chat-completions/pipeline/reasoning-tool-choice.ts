import { defineStage } from '../../pipeline/facts.ts';

export const disableOpenAIChatCompletionsForcedToolReasoning = defineStage({
  name: 'openaiChatCompletions.disable-reasoning-on-forced-tool-choice',
  through: {
    request: { needs: ['openaiChatCompletions', 'model'], provides: ['openaiChatCompletions'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const payload = facts.openaiChatCompletions;
    const choice = payload.tool_choice;
    const forced = choice === 'required' || (choice !== null && typeof choice === 'object');
    if (!forced || !facts.model.enabledFlags.includes('disable-reasoning-on-forced-tool-choice')) return await scope.next(facts);
    return await scope.next({ ...facts, openaiChatCompletions: { ...payload, reasoning_effort: 'none' } });
  },
});
