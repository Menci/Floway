import { defineStage } from '../facts.ts';

export const normalizeOpenAIResponsesVendor = defineStage({
  name: 'kimi-code.openaiResponses.normalize-vendor',
  through: {
    request: { needs: ['model', 'openaiResponses'], provides: ['openaiResponses'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const { model: { enabledFlags }, openaiResponses: payload } = facts;
    if (payload.reasoning?.effort !== 'none') return await scope.next(facts);
    const { reasoning: _reasoning, ...rest } = payload;
    if (enabledFlags.includes('vendor-deepseek')) {
      // https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
      const wire = { ...rest, thinking: { type: 'disabled' } };
      return await scope.next({ ...facts, openaiResponses: wire });
    }
    if (enabledFlags.includes('vendor-qwen')) {
      // https://www.alibabacloud.com/help/en/model-studio/deep-thinking
      const wire = { ...rest, enable_thinking: false };
      return await scope.next({ ...facts, openaiResponses: wire });
    }
    return await scope.next(facts);
  },
});
