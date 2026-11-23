import type { RouteCandidate } from '../../../pipeline/services.ts';
import type { ChatBodyOutput } from '../../shared/route-body.ts';
import { defineStage } from '@floway-dev/pipeline';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import type { ChatTargetApi, ProviderResponsesOutput } from '@floway-dev/provider';

export interface ResponsesBodyFacts {
  readonly 'request.openaiResponses': CanonicalOpenAIResponsesPayload;
  readonly 'route.candidate': RouteCandidate;
  readonly 'route.targetApi': ChatTargetApi;
}

export type ResponsesBodyBack = ChatBodyOutput<'openaiResponses'> & Partial<Pick<ProviderResponsesOutput, 'response.result'>>;

export const responsesBodyRequest = {
  needs: ['request.openaiResponses', 'route.candidate', 'route.targetApi'],
  consumes: [],
  provides: ['request.openaiResponses'],
};

export const responsesPayloadStage = (
  name: string,
  rewrite: (payload: CanonicalOpenAIResponsesPayload, facts: ResponsesBodyFacts) => CanonicalOpenAIResponsesPayload,
) => defineStage<ResponsesBodyFacts, ResponsesBodyFacts, object, object>({
  name,
  through: {
    request: responsesBodyRequest,
    response: { needs: [], consumes: [], provides: [] },
  },
  execute: async (facts, next) => await next({
    ...facts,
    'request.openaiResponses': rewrite(facts['request.openaiResponses'], facts),
  }),
});
