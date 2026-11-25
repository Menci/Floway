import { chatgptFactSpace } from '../facts.ts';
import { transform } from '@floway-dev/pipeline';

const { defineStage } = chatgptFactSpace;

// https://www.alibabacloud.com/help/en/model-studio/deep-thinking
export const normalizeQwen = defineStage({
  name: 'chatgpt.openaiResponses.normalize-qwen',
  through: {
    request: { needs: ['provider.model', 'request.openaiResponses'], provides: ['request.openaiResponses'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request(facts) {
      const payload = facts['request.openaiResponses'];
      if (!facts['provider.model'].enabledFlags.includes('vendor-qwen') || payload.reasoning?.effort !== 'none') return facts;
      const { reasoning: _reasoning, ...rest } = payload;
      return { ...facts, 'request.openaiResponses': { ...rest, enable_thinking: false } };
    },
  })),
});
