import { factSpace, transform } from '@floway-dev/pipeline';
import type { GatewayFacts } from '@floway-dev/provider';

const { defineStage } = factSpace<GatewayFacts>();

// https://www.alibabacloud.com/help/en/model-studio/deep-thinking
export const normalizeQwen = defineStage({
  name: 'custom.openaiResponses.normalize-qwen',
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
