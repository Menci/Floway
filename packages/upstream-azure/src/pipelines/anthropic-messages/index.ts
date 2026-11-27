import { readAzureUpstreamConfig } from '../../config.ts';
import { azureAnthropicMessagesUrl } from '../../endpoint.ts';
import { compose, defineStage } from '../fact-space.ts';
import { filterAzureAnthropicHeaders } from '../filter-anthropic-headers.ts';
import { azureRequest, anthropicError, jsonBody, parseAzureStream } from '../http.ts';
import { decodeAnthropicMessagesStream } from '@floway-dev/protocols/anthropic-messages';
import { httpTerminal } from '@floway-dev/upstream';

const dial = defineStage({
  name: 'azure.anthropicMessages.dial',
  through: {
    request: { needs: ['http', 'upstream', 'model', 'anthropicMessages'], provides: ['http'], consumes: [] },
    response: { needs: ['http', 'http.error?'], provides: ['http', 'anthropicMessages'], consumes: ['http.error'] },
  },
  async execute(facts, scope) {
    const { endpoint, apiKey } = readAzureUpstreamConfig(facts.upstream);
    const url = azureAnthropicMessagesUrl(endpoint, '/v1/messages');
    const body = jsonBody({ ...facts.anthropicMessages, stream: true, model: facts.model.upstreamModelId });
    const httpRequest = azureRequest(facts.http, url, apiKey, body, 'anthropic');
    const { 'http.error': failure, ...answer } = await scope.next({ ...facts, http: httpRequest });
    const parsed = await parseAzureStream(answer.http, failure, scope, decodeAnthropicMessagesStream, anthropicError);
    return { ...answer, http: parsed.http, anthropicMessages: parsed.outcome };
  },
});

export const azureAnthropicMessagesPipeline = compose('azure.anthropicMessages', {
  entry: ['http', 'upstream', 'model', 'anthropicMessages'],
  exit: ['http', 'anthropicMessages'],
  stages: [filterAzureAnthropicHeaders, dial],
  ending: httpTerminal,
});
