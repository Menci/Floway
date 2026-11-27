import { defineStage } from '../../pipeline/facts.ts';

export const stripOpenAIResponsesPromptCacheKey = defineStage({
  name: 'openaiResponses.strip-prompt-cache-key',
  through: {
    request: { needs: ['openaiResponses', 'model'], provides: ['openaiResponses'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    if (!facts.model.enabledFlags.includes('strip-prompt-cache-key')) return await scope.next(facts);
    const { prompt_cache_key: _promptCacheKey, ...payload } = facts.openaiResponses;
    return await scope.next({ ...facts, openaiResponses: payload });
  },
});
