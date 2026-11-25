import { factSpace, move, transform } from '@floway-dev/pipeline';
import type { GatewayFacts } from '@floway-dev/provider';

const { defineStage } = factSpace<Pick<GatewayFacts, 'request.openaiChatCompletions'>>();

// Ollama maps max_tokens to num_predict and ignores max_completion_tokens.
// https://github.com/ollama/ollama/blob/9a4b136efefecb51b428d22e79b0f3d15769a1f8/openai/openai.go#L110-L125
// https://github.com/ollama/ollama/blob/9a4b136efefecb51b428d22e79b0f3d15769a1f8/openai/openai.go#L753-L755
export const renameOutputCap = defineStage({
  name: 'ollama.renameOutputCap',
  through: {
    request: { needs: ['request.openaiChatCompletions'], provides: ['request.openaiChatCompletions'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request: facts => {
      const { max_completion_tokens: cap, ...payload } = facts['request.openaiChatCompletions'];
      if (cap === undefined || payload.max_tokens !== undefined) return facts;
      return { ...facts, 'request.openaiChatCompletions': move({ ...payload, max_tokens: cap }) };
    },
  })),
});
