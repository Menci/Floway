import { azureOpenAiV1BaseUrl } from '../../endpoint.ts';
import { parseJsonObject } from '../parse-json-object.ts';
import { prepareRequest, upstreamConfig } from '../prepare-request.ts';
import { stripAzureHeaders } from '../strip-headers.ts';
import { factSpace, move, transform, type Result } from '@floway-dev/pipeline';
import { formatOpenAICompletionsError, parseOpenAICompletionsStream, type OpenAICompletionsResult } from '@floway-dev/protocols/openai-completions';
import { httpTerminal, type ProviderOperationFacts, type ProviderTransportFacts, type ProviderServices, joinBaseAndPath, parseResultBody, parseSseBody } from '@floway-dev/provider';

const { compose, defineStage } = factSpace<ProviderOperationFacts<'openaiCompletions'> & ProviderTransportFacts, ProviderServices>();

const call = defineStage({
  name: 'azure.openaiCompletions.call',
  through: {
    request: {
      needs: ['request.http', 'request.openaiCompletions', 'provider.upstream', 'provider.model'],
      provides: ['request.http'],
      consumes: [],
    },
    response: {
      needs: ['response.transport'],
      provides: ['response.http', 'response.modelKey', 'response.openaiCompletions'],
      consumes: ['response.transport'],
    },
  },
  execute: transform(scope => {
    let modelKey: string;
    let streaming: boolean;
    return {
      request: facts => {
        const config = upstreamConfig(facts['provider.upstream']);
        const { upstreamModelId } = facts['provider.model'];
        modelKey = upstreamModelId;
        streaming = facts['request.openaiCompletions'].stream === true;
        const body = { ...facts['request.openaiCompletions'], model: modelKey };
        const request = prepareRequest(facts['request.http'], config, joinBaseAndPath(azureOpenAiV1BaseUrl(config.endpoint), '/completions'), body);
        return { ...facts, 'request.http': move(request) };
      },
      response: async back => {
        const { http, outcome } = streaming
          ? await parseSseBody(back, scope, parseOpenAICompletionsStream, { kind: 'doneFrame' }, formatOpenAICompletionsError)
          : await parseResultBody(back, parseCompletions, formatOpenAICompletionsError);
        const { 'response.transport': _transport, ...response } = back;
        return { ...response, 'response.http': move(http), 'response.modelKey': modelKey, 'response.openaiCompletions': move(outcome) };
      },
    };
  }),
});

const parseCompletions = (bytes: Uint8Array): Result<OpenAICompletionsResult, unknown> => {
  const json = parseJsonObject(bytes);
  if (!json.ok) return json;
  const { id, object, created, model, choices } = json.value;
  if (typeof id !== 'string' || object !== 'text_completion' || typeof created !== 'number' || typeof model !== 'string' || !Array.isArray(choices)) {
    return { ok: false, error: new TypeError('Malformed OpenAI Completions result') };
  }
  return { ok: true, value: { ...json.value, id, object, created, model, choices } };
};

export const openaiCompletions = compose('azure.openaiCompletions', {
  entry: ['request.http', 'request.openaiCompletions', 'provider.upstream', 'provider.model'],
  exit: ['response.http', 'response.modelKey', 'response.openaiCompletions'],
  stages: [stripAzureHeaders, call],
  ending: httpTerminal,
});
