import type { ProviderResponse, ProviderServices } from '../pipeline.ts';
import type { HttpResponseFacts } from '@floway-dev/http/pipeline';
import { defineStage, move } from '@floway-dev/pipeline';

type Request = { 'request.provider.modelKey': string; 'request.provider.responsesAction': 'generate' | 'compact' };
type Response = ProviderResponse & { 'response.provider.responsesAction'?: 'generate' | 'compact' };

const observeCall = (responses: boolean) => defineStage<Request, Request, HttpResponseFacts, Response, ProviderServices>({
  name: responses ? 'observeProviderResponsesCall' : 'observeProviderCall',
  through: {
    request: { needs: ['request.provider.modelKey', ...(responses ? ['request.provider.responsesAction' as const] : [])], consumes: [], provides: [] },
    response: { needs: ['response.http.exchange'], consumes: [], provides: ['response.provider.modelKey', 'response.provider.called', 'response.provider.previousCalls', ...(responses ? ['response.provider.responsesAction' as const] : [])] },
  },
  execute: async (facts, next) => {
    const back = await next(move({ ...facts }));
    return move({
      ...back,
      'response.provider.modelKey': facts['request.provider.modelKey'],
      'response.provider.called': back['response.http.exchange'].type === 'response',
      'response.provider.previousCalls': [],
      ...(responses ? { 'response.provider.responsesAction': facts['request.provider.responsesAction'] } : {}),
    });
  },
});

export const observeProviderCall = observeCall(false);
export const observeProviderResponsesCall = observeCall(true);
