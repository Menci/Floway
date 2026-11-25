import { fillInputDescriptions } from './fill-empty-namespace-descriptions.ts';
import { factSpace, transform } from '@floway-dev/pipeline';
import type { GatewayFacts } from '@floway-dev/provider';

const { defineStage } = factSpace<GatewayFacts>();

export const fillEmptyCompactNamespaceDescriptions = defineStage({
  name: 'azure.openaiResponsesCompact.fill-empty-namespace-descriptions',
  through: {
    request: { needs: ['request.openaiResponsesCompact'], provides: ['request.openaiResponsesCompact'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request(facts) {
      const payload = facts['request.openaiResponsesCompact'];
      const input = fillInputDescriptions(payload.input);
      return input === payload.input ? facts : { ...facts, 'request.openaiResponsesCompact': { ...payload, input } };
    },
  })),
});
