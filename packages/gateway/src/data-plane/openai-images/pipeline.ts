import { createJsonPassthroughPipeline } from '../pipeline/index.ts';
import { tokenUsageFromOpenAIImagesBody } from '../shared/telemetry/usage.ts';
import type { ImageEditsPipelineRequest } from '@floway-dev/provider';

export const openaiImagesGenerationsPipeline = createJsonPassthroughPipeline<Record<string, unknown>, 'openaiImagesGenerations'>({
  name: 'gateway.openai-images-generations',
  sourceApi: '/images/generations',
  operation: 'image_generation',
  kind: 'image',
  endpointKey: 'openaiImagesGenerations',
  modelServesEndpoint: candidate => candidate.endpoints.openaiImagesGenerations !== undefined,
  buildProviderInput: (facts, filteredHeaders) => ({
    'route.candidate': facts['route.candidate'],
    'provider.model': facts['route.candidate'].providerModel,
    'request.inboundHeaders': filteredHeaders,
    'request.payload': facts['request.payload'],
  }),
  extractBilling: tokenUsageFromOpenAIImagesBody,
});

export const openaiImagesEditsPipeline = createJsonPassthroughPipeline<ImageEditsPipelineRequest, 'openaiImagesEdits'>({
  name: 'gateway.openai-images-edits',
  sourceApi: '/images/edits',
  operation: 'image_edit',
  kind: 'image',
  endpointKey: 'openaiImagesEdits',
  modelServesEndpoint: candidate => candidate.endpoints.openaiImagesEdits !== undefined,
  buildProviderInput: (facts, filteredHeaders) => ({
    'route.candidate': facts['route.candidate'],
    'provider.model': facts['route.candidate'].providerModel,
    'request.inboundHeaders': filteredHeaders,
    'request.payload': facts['request.payload'],
  }),
  extractBilling: tokenUsageFromOpenAIImagesBody,
});
