import { defineStage, move } from '@floway-dev/pipeline';

type Facts = { 'request.provider.responsesAction': 'generate' | 'compact' };

export const selectProviderResponsesAction = (action: Facts['request.provider.responsesAction']) => defineStage<object, Facts, object, object>({
  name: 'selectProviderResponsesAction',
  through: {
    request: { needs: [], consumes: [], provides: ['request.provider.responsesAction'] },
    response: { needs: [], consumes: [], provides: [] },
  },
  execute: async (facts, next) => move({ ...await next(move({ ...facts, 'request.provider.responsesAction': action })) }),
});
