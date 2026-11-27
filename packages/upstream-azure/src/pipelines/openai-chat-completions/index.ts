import { readAzureUpstreamConfig } from '../../config.ts';
import { azureOpenAIUrl } from '../../endpoint.ts';
import { compose, defineStage } from '../fact-space.ts';
import { filterAzureHeaders } from '../filter-headers.ts';
import { azureRequest, jsonBody, parseAzureStream } from '../http.ts';
import { azureChatCompletionsEventNormalizer, azureChatCompletionsWirePayload } from './normalize-vendors.ts';
import { decodeOpenAIChatCompletionsStream } from '@floway-dev/protocols/openai-chat-completions';
import { httpTerminal } from '@floway-dev/upstream';

const dial = defineStage({
  name: 'azure.openaiChatCompletions.dial',
  through: {
    request: { needs: ['http', 'upstream', 'model', 'openaiChatCompletions'], provides: ['http'], consumes: [] },
    response: { needs: ['http', 'http.error?'], provides: ['http', 'openaiChatCompletions'], consumes: ['http.error'] },
  },
  async execute(facts, scope) {
    const { endpoint, apiKey } = readAzureUpstreamConfig(facts.upstream);
    const url = azureOpenAIUrl(endpoint, '/chat/completions');
    const { enabledFlags, upstreamModelId } = facts.model;
    const wire = azureChatCompletionsWirePayload(facts.openaiChatCompletions, enabledFlags);
    const body = jsonBody({ ...wire, stream: true, model: upstreamModelId });
    const httpRequest = azureRequest(facts.http, url, apiKey, body);
    const { 'http.error': failure, ...answer } = await scope.next({ ...facts, http: httpRequest });
    const { http, outcome } = await parseAzureStream(answer.http, failure, scope, decodeOpenAIChatCompletionsStream);
    const normalize = azureChatCompletionsEventNormalizer(enabledFlags);
    if (outcome.kind !== 'stream' || normalize === undefined) return { ...answer, http, openaiChatCompletions: outcome };
    const stream = scope.wrapStream(outcome.stream, async function* (source, producer) {
      for await (const item of producer.read(source)) {
        if (!item.ok) {
          yield item;
          continue;
        }
        const value = normalize(item.value);
        yield value === item.value ? item : { ok: true, value };
      }
    });
    return { ...answer, http, openaiChatCompletions: { ...outcome, stream } };
  },
});

export const azureOpenAIChatCompletionsPipeline = compose('azure.openaiChatCompletions', {
  entry: ['http', 'upstream', 'model', 'openaiChatCompletions'],
  exit: ['http', 'openaiChatCompletions'],
  stages: [filterAzureHeaders, dial],
  ending: httpTerminal,
});
