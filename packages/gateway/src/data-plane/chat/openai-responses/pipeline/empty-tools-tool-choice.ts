import { defineStage } from '../../pipeline/facts.ts';
import { collectOpenAIResponsesTools } from '@floway-dev/protocols/openai-responses';

export const normalizeOpenAIResponsesEmptyToolsToolChoice = defineStage({
  name: 'openaiResponses.normalize-empty-tools-tool-choice',
  through: {
    request: { needs: ['openaiResponses', 'model'], provides: ['openaiResponses'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const payload = facts.openaiResponses;
    if (!facts.model.enabledFlags.includes('empty-tools-tool-choice-none')
      || !Array.isArray(payload.tools) || payload.tools.length !== 0
      || collectOpenAIResponsesTools(payload).length !== 0) return await scope.next(facts);
    return await scope.next({ ...facts, openaiResponses: { ...payload, tool_choice: 'none' } });
  },
});
