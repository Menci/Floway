import { defineStage } from '../../pipeline/facts.ts';

export const forceOpenAIResponsesStoreFalse = defineStage({
  name: 'openaiResponses.force-store-false',
  through: {
    request: { needs: ['request.openaiResponses', 'provider.model'], provides: ['request.openaiResponses'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const payload = facts['request.openaiResponses'];
    if (!facts['provider.model'].enabledFlags.includes('openai-responses-store-false') || payload.store === false) {
      return await scope.next(facts);
    }
    return await scope.next({ ...facts, 'request.openaiResponses': { ...payload, store: false } });
  },
});
