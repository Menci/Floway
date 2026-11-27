import { defineStage } from '../../pipeline/facts.ts';

export const stripOpenAIChatCompletionsPromptCacheKey = defineStage({
  name: 'openaiChatCompletions.strip-prompt-cache-key',
  through: {
    request: { needs: ['openaiChatCompletions', 'model'], provides: ['openaiChatCompletions'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    if (!facts.model.enabledFlags.includes('strip-prompt-cache-key')) return await scope.next(facts);
    const { prompt_cache_key: _promptCacheKey, ...payload } = facts.openaiChatCompletions;
    return await scope.next({ ...facts, openaiChatCompletions: payload });
  },
});
