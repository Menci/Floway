import { readAzureUpstreamConfig } from '../../config.ts';
import { azureOpenAIUrl } from '../../endpoint.ts';
import { compose, defineStage } from '../fact-space.ts';
import { filterAzureHeaders } from '../filter-headers.ts';
import { azureRequest, decodeJsonBody, jsonBody, parseAzureResult, parseAzureStream } from '../http.ts';
import { decodeOpenAICompletionsResult, decodeOpenAICompletionsStream } from '@floway-dev/protocols/openai-completions';
import { httpTerminal } from '@floway-dev/upstream';

const dial = defineStage({
  name: 'azure.openaiCompletions.dial',
  through: {
    request: { needs: ['http', 'upstream', 'model', 'openaiCompletions'], provides: ['http'], consumes: [] },
    response: { needs: ['http', 'http.error?'], provides: ['http', 'openaiCompletions'], consumes: ['http.error'] },
  },
  async execute(facts, scope) {
    const { endpoint, apiKey } = readAzureUpstreamConfig(facts.upstream);
    const url = azureOpenAIUrl(endpoint, '/completions');
    const body = jsonBody({ ...facts.openaiCompletions, model: facts.model.upstreamModelId });
    const httpRequest = azureRequest(facts.http, url, apiKey, body);
    const { 'http.error': failure, ...answer } = await scope.next({ ...facts, http: httpRequest });
    const parsed = facts.openaiCompletions.stream === true
      ? await parseAzureStream(answer.http, failure, scope, decodeOpenAICompletionsStream)
      : await parseAzureResult(answer.http, failure, scope, bytes => decodeJsonBody(bytes, decodeOpenAICompletionsResult));
    return { ...answer, http: parsed.http, openaiCompletions: parsed.outcome };
  },
});

export const azureOpenAICompletionsPipeline = compose('azure.openaiCompletions', {
  entry: ['http', 'upstream', 'model', 'openaiCompletions'],
  exit: ['http', 'openaiCompletions'],
  stages: [filterAzureHeaders, dial],
  ending: httpTerminal,
});
