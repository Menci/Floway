import type { GatewayPipelineFacts } from '../../pipeline/facts.ts';
import type { GatewayServices } from '../../pipeline/services.ts';
import { factSpace } from '@floway-dev/pipeline';
import type { CanonicalOpenAIResponsesCompactPayload, CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';

export interface OpenAIResponsesDelivery {
  stream: boolean;
  createdAt: number;
}

export type OpenAIResponsesCompactRequest = Omit<CanonicalOpenAIResponsesPayload, 'prompt_cache_options'>
  & Pick<CanonicalOpenAIResponsesCompactPayload, 'prompt_cache_options'>;

type OpenAIResponsesFacts = Omit<GatewayPipelineFacts, 'request.openaiResponsesCompact'> & {
  'request.openaiResponsesCompact': OpenAIResponsesCompactRequest;
  'request.delivery': OpenAIResponsesDelivery;
  'request.ws.responseId': string;
};

export const openAIResponsesCompactGenerationPayload = (request: OpenAIResponsesCompactRequest): CanonicalOpenAIResponsesPayload => {
  const { prompt_cache_options: cacheOptions, ...payload } = request;
  return cacheOptions == null ? payload : { ...payload, prompt_cache_options: cacheOptions };
};

export const { defineStage: defineOpenAIResponsesStage } = factSpace<OpenAIResponsesFacts, GatewayServices>();
