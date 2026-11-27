import { readAzureUpstreamConfig } from '../../config.ts';
import { azureOpenAIUrl } from '../../endpoint.ts';
import { fillAzureResponsesNamespaceDescriptions } from '../../responses-namespace-descriptions.ts';
import { compose, defineStage } from '../fact-space.ts';
import { filterAzureHeaders } from '../filter-headers.ts';
import { azureRequest, jsonBody, parseAzureStream } from '../http.ts';
import { normalizeResponsesVendors } from './normalize-vendors.ts';
import { decodeOpenAIResponsesStream } from '@floway-dev/protocols/openai-responses';
import { httpTerminal } from '@floway-dev/upstream';

const dial = defineStage({
  name: 'azure.openaiResponses.dial',
  through: {
    request: { needs: ['http', 'upstream', 'model', 'openaiResponses'], provides: ['http'], consumes: [] },
    response: { needs: ['http', 'http.error?'], provides: ['http', 'openaiResponses'], consumes: ['http.error'] },
  },
  async execute(facts, scope) {
    const { endpoint, apiKey } = readAzureUpstreamConfig(facts.upstream);
    const url = azureOpenAIUrl(endpoint, '/responses');
    const body = jsonBody({ ...fillAzureResponsesNamespaceDescriptions(facts.openaiResponses), stream: true, model: facts.model.upstreamModelId });
    const httpRequest = azureRequest(facts.http, url, apiKey, body);
    const { 'http.error': failure, ...answer } = await scope.next({ ...facts, http: httpRequest });
    const parsed = await parseAzureStream(answer.http, failure, scope, decodeOpenAIResponsesStream);
    return { ...answer, http: parsed.http, openaiResponses: parsed.outcome };
  },
});

export const azureOpenAIResponsesPipeline = compose('azure.openaiResponses', {
  entry: ['http', 'upstream', 'model', 'openaiResponses'],
  exit: ['http', 'openaiResponses'],
  stages: [filterAzureHeaders, normalizeResponsesVendors, dial],
  ending: httpTerminal,
});
