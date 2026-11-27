import { readAzureUpstreamConfig } from '../../config.ts';
import { azureOpenAIUrl } from '../../endpoint.ts';
import { compose, defineStage } from '../fact-space.ts';
import { filterAzureHeaders } from '../filter-headers.ts';
import { azureRequest, decodeJsonObject, jsonBody, parseAzureResult } from '../http.ts';
import { httpTerminal } from '@floway-dev/upstream';

const dial = defineStage({
  name: 'azure.openaiEmbeddings.dial',
  through: {
    request: { needs: ['http', 'upstream', 'model', 'openaiEmbeddings'], provides: ['http'], consumes: [] },
    response: { needs: ['http', 'http.error?'], provides: ['http', 'openaiEmbeddings'], consumes: ['http.error'] },
  },
  async execute(facts, scope) {
    const { endpoint, apiKey } = readAzureUpstreamConfig(facts.upstream);
    const url = azureOpenAIUrl(endpoint, '/embeddings');
    const body = jsonBody({ ...facts.openaiEmbeddings, model: facts.model.upstreamModelId });
    const httpRequest = azureRequest(facts.http, url, apiKey, body);
    const { 'http.error': failure, ...answer } = await scope.next({ ...facts, http: httpRequest });
    const parsed = await parseAzureResult(answer.http, failure, scope, decodeJsonObject);
    return { ...answer, http: parsed.http, openaiEmbeddings: parsed.outcome };
  },
});

export const azureOpenAIEmbeddingsPipeline = compose('azure.openaiEmbeddings', {
  entry: ['http', 'upstream', 'model', 'openaiEmbeddings'],
  exit: ['http', 'openaiEmbeddings'],
  stages: [filterAzureHeaders, dial],
  ending: httpTerminal,
});
