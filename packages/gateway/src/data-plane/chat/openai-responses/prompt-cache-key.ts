import { defineStage } from '../../pipeline/facts.ts';

export const stripOpenAIResponsesPromptCacheKey = defineStage({
  name: 'openaiResponses.strip-prompt-cache-key',
  through: {
    request: { needs: ['request.openaiResponses', 'provider.model'], provides: ['request.openaiResponses'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const payload = facts['request.openaiResponses'];
    if (!facts['provider.model'].enabledFlags.includes('strip-prompt-cache-key') || payload.prompt_cache_key === undefined) {
      return await scope.next(facts);
    }
    const { prompt_cache_key: _cacheKey, ...rest } = payload;
    return await scope.next({ ...facts, 'request.openaiResponses': rest });
  },
});
