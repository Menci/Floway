import { gatewayFactSpace } from '../../../pipeline/facts.ts';
import { move, transform } from '@floway-dev/pipeline';

const { defineStage } = gatewayFactSpace<{}>();
const key = 'request.openaiChatCompletions';

export const normalizeEmptyToolsToolChoice = defineStage({
  name: 'openaiChatCompletions.normalize-empty-tools-tool-choice',
  through: {
    request: { needs: [key, 'serve.candidate'], provides: [key], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request: facts => {
      const payload = facts[key];
      if (!facts['serve.candidate'].model.enabledFlags.includes('empty-tools-tool-choice-none') || !Array.isArray(payload.tools) || payload.tools.length !== 0) return facts;
      return { ...facts, [key]: move({ ...payload, tool_choice: 'none' }) };
    },
  })),
});
