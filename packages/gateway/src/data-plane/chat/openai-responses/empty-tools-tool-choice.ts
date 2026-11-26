import { defineStage } from '../../pipeline/facts.ts';
import { collectOpenAIResponsesTools } from '@floway-dev/protocols/openai-responses';

export const normalizeOpenAIResponsesEmptyToolsToolChoice = defineStage({
  name: 'openaiResponses.normalize-empty-tools-tool-choice',
  through: {
    request: { needs: ['request.openaiResponses', 'provider.model'], provides: ['request.openaiResponses'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const payload = facts['request.openaiResponses'];
    if (!facts['provider.model'].enabledFlags.includes('empty-tools-tool-choice-none')
      || !Array.isArray(payload.tools) || payload.tools.length !== 0
      || collectOpenAIResponsesTools(payload).length !== 0) return await scope.next(facts);

    return await scope.next({ ...facts, 'request.openaiResponses': { ...payload, tool_choice: 'none' } });
  },
});
