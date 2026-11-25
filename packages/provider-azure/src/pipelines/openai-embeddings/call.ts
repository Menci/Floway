import { azureOpenAiV1BaseUrl } from '../../endpoint.ts';
import { parseJsonObject } from '../parse-json-object.ts';
import { prepareRequest, upstreamConfig } from '../prepare-request.ts';
import { stripAzureHeaders } from '../strip-headers.ts';
import { factSpace, move, transform } from '@floway-dev/pipeline';
import { formatOpenAIEmbeddingsError } from '@floway-dev/protocols/openai-embeddings';
import { httpTerminal, type ProviderOperationFacts, type ProviderTransportFacts, type ProviderServices, joinBaseAndPath, parseResultBody } from '@floway-dev/provider';

const { compose, defineStage } = factSpace<ProviderOperationFacts<'openaiEmbeddings'> & ProviderTransportFacts, ProviderServices>();

const call = defineStage({
  name: 'azure.openaiEmbeddings.call',
  through: {
    request: {
      needs: ['request.http', 'request.openaiEmbeddings', 'provider.upstream', 'provider.model'],
      provides: ['request.http'],
      consumes: [],
    },
    response: {
      needs: ['response.transport'],
      provides: ['response.http', 'response.modelKey', 'response.openaiEmbeddings'],
      consumes: ['response.transport'],
    },
  },
  execute: transform(() => {
    let modelKey: string;
    return {
      request: facts => {
        const config = upstreamConfig(facts['provider.upstream']);
        const { upstreamModelId } = facts['provider.model'];
        modelKey = upstreamModelId;
        const body = { ...facts['request.openaiEmbeddings'], model: modelKey };
        const request = prepareRequest(facts['request.http'], config, joinBaseAndPath(azureOpenAiV1BaseUrl(config.endpoint), '/embeddings'), body);
        return { ...facts, 'request.http': move(request) };
      },
      response: async back => {
        const { http, outcome } = await parseResultBody(back, bytes => parseJsonObject(bytes), formatOpenAIEmbeddingsError);
        const { 'response.transport': _transport, ...response } = back;
        return { ...response, 'response.http': move(http), 'response.modelKey': modelKey, 'response.openaiEmbeddings': move(outcome) };
      },
    };
  }),
});

export const openaiEmbeddings = compose('azure.openaiEmbeddings', {
  entry: ['request.http', 'request.openaiEmbeddings', 'provider.upstream', 'provider.model'],
  exit: ['response.http', 'response.modelKey', 'response.openaiEmbeddings'],
  stages: [stripAzureHeaders, call],
  ending: httpTerminal,
});
