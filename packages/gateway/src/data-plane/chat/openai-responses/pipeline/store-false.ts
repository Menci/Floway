import { defineStage } from '../../pipeline/facts.ts';

export const forceOpenAIResponsesStoreFalse = defineStage({
  name: 'openaiResponses.force-store-false',
  through: {
    request: { needs: ['openaiResponses', 'model'], provides: ['openaiResponses'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    if (!facts.model.enabledFlags.includes('openai-responses-store-false')) return await scope.next(facts);
    return await scope.next({ ...facts, openaiResponses: { ...facts.openaiResponses, store: false } });
  },
});
