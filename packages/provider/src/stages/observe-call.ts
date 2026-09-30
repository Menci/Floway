import type { ProviderResponse, ProviderServices } from '../pipeline.ts';
import type { HttpResponseFacts } from '@floway-dev/http/pipeline';
import { defineStage, move } from '@floway-dev/pipeline';

type Request = { 'request.provider.modelKey': string };

export const observeProviderCall = defineStage<Request, Request, HttpResponseFacts, ProviderResponse, ProviderServices>({
  name: 'observeProviderCall',
  through: {
    request: { needs: ['request.provider.modelKey'], consumes: [], provides: [] },
    response: { needs: ['response.http.exchange'], consumes: [], provides: ['response.provider.modelKey', 'response.provider.called', 'response.provider.previousCalls'] },
  },
  execute: async (facts, next) => {
    const back = await next(move({ ...facts }));
    return move({
      ...back,
      'response.provider.modelKey': facts['request.provider.modelKey'],
      'response.provider.called': back['response.http.exchange'].type === 'response',
      'response.provider.previousCalls': [],
    });
  },
});
