import { gatewayFactSpace } from '../../../pipeline/facts.ts';
import { move, transform } from '@floway-dev/pipeline';

const { defineStage } = gatewayFactSpace<{}>();
const key = 'request.anthropicMessages';

export const disableReasoningOnForcedToolChoice = defineStage({
  name: 'anthropicMessages.disable-reasoning-on-forced-tool-choice',
  through: {
    request: { needs: [key, 'serve.candidate'], provides: [key], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request: facts => {
      const payload = facts[key];
      const choice = payload.tool_choice?.type;
      if (!facts['serve.candidate'].model.enabledFlags.includes('disable-reasoning-on-forced-tool-choice') || (choice !== 'tool' && choice !== 'any')) return facts;

      // Forced tool choice can coexist with output_config.format. Only effort
      // takes the same role as thinking.
      const { output_config: outputConfig, ...request } = payload;
      const { effort: _effort, ...remaining } = outputConfig ?? {};
      return {
        ...facts,
        [key]: move({
          ...request,
          thinking: { type: 'disabled' },
          ...(Object.keys(remaining).length > 0 ? { output_config: remaining } : {}),
        }),
      };
    },
  })),
});
