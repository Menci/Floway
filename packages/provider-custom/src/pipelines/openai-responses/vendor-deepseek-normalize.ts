import { factSpace, transform } from '@floway-dev/pipeline';
import type { GatewayFacts } from '@floway-dev/provider';

const { defineStage } = factSpace<GatewayFacts>();

// https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
export const normalizeDeepSeek = defineStage({
  name: 'custom.openaiResponses.normalize-deepseek',
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
