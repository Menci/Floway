import { gatewayFactSpace } from '../../../pipeline/facts.ts';
import { move, transform } from '@floway-dev/pipeline';

const { defineStage } = gatewayFactSpace<{}>();

export const forceOpenAIResponsesStoreFalse = defineStage({
  name: 'openaiResponses.force-store-false',
  through: {
    request: { needs: ['request.openaiResponses', 'serve.candidate'], provides: ['request.openaiResponses'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request(facts) {
      if (!facts['serve.candidate'].model.enabledFlags.includes('openai-responses-store-false')) return facts;
      return { ...facts, 'request.openaiResponses': move({ ...facts['request.openaiResponses'], store: false }) };
    },
  })),
});
