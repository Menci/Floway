import { readAzureUpstreamConfig } from '../../config.ts';
import { azureOpenAIUrl } from '../../endpoint.ts';
import { fillAzureResponsesInputNamespaceDescriptions } from '../../responses-namespace-descriptions.ts';
import { compose, defineStage } from '../fact-space.ts';
import { filterAzureHeaders } from '../filter-headers.ts';
import { azureRequest, decodeJsonBody, jsonBody, parseAzureResult } from '../http.ts';
import { decodeOpenAIResponsesCompactionResult, toCompactPayloadShape } from '@floway-dev/protocols/openai-responses';
import { httpTerminal } from '@floway-dev/upstream';

const dial = defineStage({
  name: 'azure.openaiResponsesCompact.dial',
  through: {
    request: { needs: ['http', 'upstream', 'model', 'openaiResponsesCompact'], provides: ['http'], consumes: [] },
    response: { needs: ['http', 'http.error?'], provides: ['http', 'openaiResponsesCompact'], consumes: ['http.error'] },
  },
  async execute(facts, scope) {
    const { endpoint, apiKey } = readAzureUpstreamConfig(facts.upstream);
    const input = fillAzureResponsesInputNamespaceDescriptions(facts.openaiResponsesCompact.input);
    const url = azureOpenAIUrl(endpoint, '/responses/compact');
    const body = jsonBody({ ...toCompactPayloadShape({ ...facts.openaiResponsesCompact, input }), model: facts.model.upstreamModelId });
    const httpRequest = azureRequest(facts.http, url, apiKey, body);
    const { 'http.error': failure, ...answer } = await scope.next({ ...facts, http: httpRequest });
    const parsed = await parseAzureResult(answer.http, failure, scope, bytes => decodeJsonBody(bytes, decodeOpenAIResponsesCompactionResult));
    return { ...answer, http: parsed.http, openaiResponsesCompact: parsed.outcome };
  },
});

export const azureOpenAIResponsesCompactPipeline = compose('azure.openaiResponsesCompact', {
  entry: ['http', 'upstream', 'model', 'openaiResponsesCompact'],
  exit: ['http', 'openaiResponsesCompact'],
  stages: [filterAzureHeaders, dial],
  ending: httpTerminal,
});
