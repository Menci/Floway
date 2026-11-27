import { readAzureUpstreamConfig } from '../../config.ts';
import { azureOpenAIImagesUrl } from '../../endpoint.ts';
import { compose, defineStage } from '../fact-space.ts';
import { filterAzureHeaders } from '../filter-headers.ts';
import { azureRequest, decodeJsonObject, MAX_AZURE_IMAGE_RESULT_BODY_BYTES, jsonBody, parseAzureStreamOrResult } from '../http.ts';
import { decodeOpenAIImagesGenerationsStream } from '@floway-dev/protocols/openai-images';
import { httpTerminal } from '@floway-dev/upstream';

const dial = defineStage({
  name: 'azure.openaiImagesGenerations.dial',
  through: {
    request: { needs: ['http', 'upstream', 'model', 'openaiImagesGenerations'], provides: ['http'], consumes: [] },
    response: { needs: ['http', 'http.error?'], provides: ['http', 'openaiImagesGenerations'], consumes: ['http.error'] },
  },
  async execute(facts, scope) {
    const { endpoint, apiKey } = readAzureUpstreamConfig(facts.upstream);
    const url = azureOpenAIImagesUrl(endpoint, '/images/generations');
    const body = jsonBody({ ...facts.openaiImagesGenerations, model: facts.model.upstreamModelId });
    const httpRequest = azureRequest(facts.http, url, apiKey, body);
    const { 'http.error': failure, ...answer } = await scope.next({ ...facts, http: httpRequest });
    const parsed = await parseAzureStreamOrResult(answer.http, failure, scope, decodeOpenAIImagesGenerationsStream, decodeJsonObject, MAX_AZURE_IMAGE_RESULT_BODY_BYTES);
    return { ...answer, http: parsed.http, openaiImagesGenerations: parsed.outcome };
  },
});

export const azureOpenAIImagesGenerationsPipeline = compose('azure.openaiImagesGenerations', {
  entry: ['http', 'upstream', 'model', 'openaiImagesGenerations'],
  exit: ['http', 'openaiImagesGenerations'],
  stages: [filterAzureHeaders, dial],
  ending: httpTerminal,
});
