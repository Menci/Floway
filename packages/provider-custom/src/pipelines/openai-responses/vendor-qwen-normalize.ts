import { factSpace, move, transform } from '@floway-dev/pipeline';
import type { ProviderOperationFacts } from '@floway-dev/provider';

const { defineStage } = factSpace<Pick<ProviderOperationFacts<'openaiResponses'>, 'provider.model' | 'request.openaiResponses'>>();

// Qwen uses its own thinking control to disable reasoning.
// https://www.alibabacloud.com/help/en/model-studio/deep-thinking
export const normalizeQwen = defineStage({
  name: 'custom.openaiResponses.normalizeQwen',
  through: {
    request: { needs: ['provider.model', 'request.openaiResponses'], provides: ['request.openaiResponses'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request: facts => {
      const payload = facts['request.openaiResponses'];
      if (!facts['provider.model'].enabledFlags.includes('vendor-qwen') || payload.reasoning?.effort !== 'none') return facts;
      const { reasoning: _reasoning, ...rest } = payload;
      const wire = { ...rest, enable_thinking: false };
      return { ...facts, 'request.openaiResponses': move(wire) };
    },
  })),
});
