import { factSpace, move, transform } from '@floway-dev/pipeline';
import type { ProviderOperationFacts } from '@floway-dev/provider';

const { defineStage } = factSpace<Pick<ProviderOperationFacts<'openaiResponses'>, 'provider.model' | 'request.openaiResponses'>>();

// DeepSeek uses its own thinking control to disable reasoning.
// https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
export const normalizeDeepSeek = defineStage({
  name: 'custom.openaiResponses.normalizeDeepSeek',
  through: {
    request: { needs: ['provider.model', 'request.openaiResponses'], provides: ['request.openaiResponses'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request: facts => {
      const payload = facts['request.openaiResponses'];
      if (!facts['provider.model'].enabledFlags.includes('vendor-deepseek') || payload.reasoning?.effort !== 'none') return facts;
      const { reasoning: _reasoning, ...rest } = payload;
      const wire = { ...rest, thinking: { type: 'disabled' } };
      return { ...facts, 'request.openaiResponses': move(wire) };
    },
  })),
});
