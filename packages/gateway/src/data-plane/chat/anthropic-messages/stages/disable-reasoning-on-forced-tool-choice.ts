import type { AnthropicMessagesCandidateRequest } from './facts.ts';
import { defineStage, transform } from '@floway-dev/pipeline';

export const disableReasoningOnForcedToolChoice = defineStage<AnthropicMessagesCandidateRequest, AnthropicMessagesCandidateRequest, object, object>({
  name: 'disableReasoningOnForcedToolChoice',
  through: {
    request: { needs: ['request.anthropicMessages', 'route.candidate'], consumes: [], provides: ['request.anthropicMessages'] },
    response: { needs: [], consumes: [], provides: [] },
  },
  execute: transform(() => ({
    request: facts => {
      const payload = facts['request.anthropicMessages'];
      const choice = payload.tool_choice?.type;
      if ((choice !== 'tool' && choice !== 'any') || !facts['route.candidate'].providerModel.enabledFlags.includes('disable-reasoning-on-forced-tool-choice')) return facts;
      const { output_config: outputConfig, ...rest } = payload;
      // Forced tools can still use structured output. Only thinking and effort conflict.
      // https://platform.claude.com/docs/en/agents-and-tools/tool-use/implement-tool-use
      const { effort: _effort, ...remaining } = outputConfig ?? {};
      return {
        ...facts,
        'request.anthropicMessages': {
          ...rest,
          thinking: { type: 'disabled' },
          ...(Object.keys(remaining).length > 0 ? { output_config: remaining } : {}),
        },
      };
    },
  })),
});
