import { defineStage } from '../../pipeline/facts.ts';

export const normalizeOpenAIChatCompletionsToolChoice = defineStage({
  name: 'openaiChatCompletions.normalize-empty-tools-tool-choice',
  through: {
    request: { needs: ['openaiChatCompletions', 'model'], provides: ['openaiChatCompletions'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const payload = facts.openaiChatCompletions;
    if (!facts.model.enabledFlags.includes('empty-tools-tool-choice-none')
      || !Array.isArray(payload.tools) || payload.tools.length !== 0) return await scope.next(facts);
    return await scope.next({ ...facts, openaiChatCompletions: { ...payload, tool_choice: 'none' } });
  },
});
