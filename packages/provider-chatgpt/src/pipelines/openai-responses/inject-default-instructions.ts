import { withChatGPTDefaultInstructions } from '../../responses-payload.ts';
import { factSpace, move, transform } from '@floway-dev/pipeline';
import type { GatewayFacts } from '@floway-dev/provider';

const { defineStage } = factSpace<GatewayFacts>();

export const injectDefaultInstructions = defineStage({
  name: 'chatgpt.inject-default-instructions',
  through: {
    request: { needs: ['request.openaiResponses', 'provider.model'], provides: ['request.openaiResponses'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request: facts => ({
      ...facts,
      'request.openaiResponses': move(withChatGPTDefaultInstructions(facts['request.openaiResponses'], facts['provider.model'])),
    }),
  })),
});
