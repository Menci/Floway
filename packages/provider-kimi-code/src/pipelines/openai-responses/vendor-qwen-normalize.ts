import { defineStage } from '../facts.ts';

// https://www.alibabacloud.com/help/en/model-studio/deep-thinking
export const normalizeQwen = defineStage({
  name: 'kimi-code.openaiResponses.vendor-qwen-normalize',
  through: {
    request: { needs: ['request.openaiResponses', 'provider.model'], provides: ['request.openaiResponses'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const payload = facts['request.openaiResponses'];
    if (!facts['provider.model'].enabledFlags.includes('vendor-qwen') || payload.reasoning?.effort !== 'none') {
      return await scope.next(facts);
    }
    const { reasoning: _reasoning, ...rest } = payload;
    const shaped = { ...rest, enable_thinking: false };
    return await scope.next({ ...facts, 'request.openaiResponses': shaped });
  },
});
