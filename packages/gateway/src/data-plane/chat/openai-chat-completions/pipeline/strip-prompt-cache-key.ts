import { gatewayFactSpace } from '../../../pipeline/facts.ts';
import { move, transform } from '@floway-dev/pipeline';

const { defineStage } = gatewayFactSpace<{}>();
const key = 'request.openaiChatCompletions';

export const stripPromptCacheKey = defineStage({
  name: 'openaiChatCompletions.strip-prompt-cache-key',
  through: {
    request: { needs: [key, 'serve.candidate'], provides: [key], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request: facts => {
      if (!facts['serve.candidate'].model.enabledFlags.includes('strip-prompt-cache-key') || facts[key].prompt_cache_key === undefined) return facts;
      const { prompt_cache_key: _stripped, ...payload } = facts[key];
      return { ...facts, [key]: move(payload) };
    },
  })),
});
