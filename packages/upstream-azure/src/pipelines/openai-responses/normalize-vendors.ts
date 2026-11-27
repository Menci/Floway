import { defineStage } from '../fact-space.ts';
import { transform } from '@floway-dev/pipeline';

export const normalizeResponsesVendors = defineStage({
  name: 'azure.openaiResponses.normalize-vendors',
  through: {
    request: { needs: ['model', 'openaiResponses'], provides: ['openaiResponses'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request(facts) {
      const { enabledFlags } = facts.model;
      const { reasoning, ...payload } = facts.openaiResponses;
      if (reasoning?.effort !== 'none') return facts;
      // https://api-docs.deepseek.com/guides/thinking_mode
      if (enabledFlags.includes('vendor-deepseek')) return { ...facts, openaiResponses: { ...payload, thinking: { type: 'disabled' } } };
      // https://www.alibabacloud.com/help/en/model-studio/deep-thinking
      if (enabledFlags.includes('vendor-qwen')) return { ...facts, openaiResponses: { ...payload, enable_thinking: false } };
      return facts;
    },
  })),
});
