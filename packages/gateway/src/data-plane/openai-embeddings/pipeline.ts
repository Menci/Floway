import { tokenUsageFromOpenAIEmbeddingsBody } from './usage.ts';
import { createJsonPassthroughPipeline } from '../pipeline/index.ts';

export const openaiEmbeddingsPipeline = createJsonPassthroughPipeline<Record<string, unknown>, 'openaiEmbeddings'>({
  name: 'gateway.openai-embeddings',
  sourceApi: '/embeddings',
  operation: 'embeddings',
  kind: 'embedding',
  endpointKey: 'openaiEmbeddings',
  modelServesEndpoint: candidate => candidate.endpoints.openaiEmbeddings !== undefined,
  buildProviderInput: (facts, filteredHeaders) => ({
    'route.candidate': facts['route.candidate'],
    'provider.model': facts['route.candidate'].providerModel,
    'request.inboundHeaders': filteredHeaders,
    'request.payload': facts['request.payload'],
  }),
  extractBilling: tokenUsageFromOpenAIEmbeddingsBody,
});
