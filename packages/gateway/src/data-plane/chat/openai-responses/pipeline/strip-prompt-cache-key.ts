import { gatewayFactSpace } from '../../../pipeline/facts.ts';
import { move, transform } from '@floway-dev/pipeline';

const { defineStage } = gatewayFactSpace<{}>();

export const stripOpenAIResponsesPromptCacheKey = defineStage({
  name: 'openaiResponses.strip-prompt-cache-key',
  through: {
    request: { needs: ['request.openaiResponses', 'serve.candidate'], provides: ['request.openaiResponses'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request(facts) {
      const payload = facts['request.openaiResponses'];
      if (!facts['serve.candidate'].model.enabledFlags.includes('strip-prompt-cache-key')
        || payload.prompt_cache_key === undefined) return facts;
      const { prompt_cache_key: _key, ...rest } = payload;
      return { ...facts, 'request.openaiResponses': move(rest) };
    },
  })),
});
