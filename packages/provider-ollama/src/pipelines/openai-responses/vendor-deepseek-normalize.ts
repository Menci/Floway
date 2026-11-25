import { defineStage } from '../facts.ts';

// https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
export const normalizeDeepSeek = defineStage({
  name: 'ollama.openaiResponses.vendor-deepseek-normalize',
  through: {
    request: { needs: ['request.openaiResponses', 'provider.model'], provides: ['request.openaiResponses'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const payload = facts['request.openaiResponses'];
    if (!facts['provider.model'].enabledFlags.includes('vendor-deepseek') || payload.reasoning?.effort !== 'none') {
      return await scope.next(facts);
    }
    const { reasoning: _reasoning, ...rest } = payload;
    const shaped = { ...rest, thinking: { type: 'disabled' } };
    return await scope.next({ ...facts, 'request.openaiResponses': shaped });
  },
});
