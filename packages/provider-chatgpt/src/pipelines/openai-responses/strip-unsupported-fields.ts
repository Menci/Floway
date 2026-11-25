import { withoutChatGPTUnsupportedFields } from '../../responses-payload.ts';
import { factSpace, move, transform } from '@floway-dev/pipeline';
import type { GatewayFacts } from '@floway-dev/provider';

const { defineStage } = factSpace<GatewayFacts>();

export const stripUnsupportedFields = defineStage({
  name: 'chatgpt.strip-unsupported-openai-responses-fields',
  through: {
    request: { needs: ['request.openaiResponses'], provides: ['request.openaiResponses'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request: facts => ({
      ...facts,
      'request.openaiResponses': move(withoutChatGPTUnsupportedFields(facts['request.openaiResponses'])),
    }),
  })),
});
