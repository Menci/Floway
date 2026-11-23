import type { AnthropicMessagesCandidateRequest } from './facts.ts';
import { defineStage, transform } from '@floway-dev/pipeline';

export const normalizeEmptyToolsToolChoice = defineStage<AnthropicMessagesCandidateRequest, AnthropicMessagesCandidateRequest, object, object>({
  name: 'normalizeEmptyToolsToolChoice',
  through: {
    request: { needs: ['request.anthropicMessages', 'route.candidate'], consumes: [], provides: ['request.anthropicMessages'] },
    response: { needs: [], consumes: [], provides: [] },
  },
  execute: transform(() => ({
    request: facts => {
      const payload = facts['request.anthropicMessages'];
      if (!Array.isArray(payload.tools) || payload.tools.length !== 0 || !facts['route.candidate'].providerModel.enabledFlags.includes('empty-tools-tool-choice-none')) return facts;
      return { ...facts, 'request.anthropicMessages': { ...payload, tool_choice: { type: 'none' } } };
    },
  })),
});
