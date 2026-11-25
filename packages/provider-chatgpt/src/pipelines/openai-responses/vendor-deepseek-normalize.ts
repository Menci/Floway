import { chatgptFactSpace } from '../facts.ts';
import { transform } from '@floway-dev/pipeline';

const { defineStage } = chatgptFactSpace;

// https://api-docs.deepseek.com/en/guides/thinking_mode
export const normalizeDeepSeek = defineStage({
  name: 'chatgpt.openaiResponses.normalize-deepseek',
  through: {
    request: { needs: ['provider.model', 'request.openaiResponses'], provides: ['request.openaiResponses'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request(facts) {
      const payload = facts['request.openaiResponses'];
      if (!facts['provider.model'].enabledFlags.includes('vendor-deepseek') || payload.reasoning?.effort !== 'none') return facts;
      const { reasoning: _reasoning, ...rest } = payload;
      return { ...facts, 'request.openaiResponses': { ...rest, thinking: { type: 'disabled' } } };
    },
  })),
});
