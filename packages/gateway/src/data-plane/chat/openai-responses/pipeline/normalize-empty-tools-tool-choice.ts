import { openAIResponsesFactSpace } from './facts.ts';
import { move, transform } from '@floway-dev/pipeline';
import { collectOpenAIResponsesTools } from '@floway-dev/protocols/openai-responses';

const { defineStage } = openAIResponsesFactSpace<{}>();

export const normalizeOpenAIResponsesEmptyToolsToolChoice = defineStage({
  name: 'openaiResponses.normalize-empty-tools-tool-choice',
  through: {
    request: { needs: ['request.openaiResponses', 'serve.candidate'], provides: ['request.openaiResponses'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request(facts) {
      const payload = facts['request.openaiResponses'];
      if (!facts['serve.candidate'].model.enabledFlags.includes('empty-tools-tool-choice-none')
        || !Array.isArray(payload.tools) || payload.tools.length !== 0
        || collectOpenAIResponsesTools(payload).length !== 0) return facts;
      return { ...facts, 'request.openaiResponses': move({ ...payload, tool_choice: 'none' }) };
    },
  })),
});
