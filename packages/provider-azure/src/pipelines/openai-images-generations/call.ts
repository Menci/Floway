import { azureOpenAiV1BaseUrl } from '../../endpoint.ts';
import { parseJsonObject } from '../parse-json-object.ts';
import { prepareRequest, upstreamConfig } from '../prepare-request.ts';
import { stripAzureHeaders } from '../strip-headers.ts';
import { factSpace, move, transform } from '@floway-dev/pipeline';
import { formatOpenAIImagesGenerationsError } from '@floway-dev/protocols/openai-images';
import { httpTerminal, type ProviderOperationFacts, type ProviderTransportFacts, type ProviderServices, joinBaseAndPath, parseResultBody } from '@floway-dev/provider';

const { compose, defineStage } = factSpace<ProviderOperationFacts<'openaiImagesGenerations'> & ProviderTransportFacts, ProviderServices>();

const call = defineStage({
  name: 'azure.openaiImagesGenerations.call',
  through: {
    request: {
      needs: ['request.http', 'request.openaiImagesGenerations', 'provider.upstream', 'provider.model'],
      provides: ['request.http'],
      consumes: [],
    },
    response: {
      needs: ['response.transport'],
      provides: ['response.http', 'response.modelKey', 'response.openaiImagesGenerations'],
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
        const body = { ...facts['request.openaiImagesGenerations'], model: modelKey };
        // https://learn.microsoft.com/en-us/azure/foundry/openai/reference-preview-latest
        const request = prepareRequest(facts['request.http'], config, joinBaseAndPath(azureOpenAiV1BaseUrl(config.endpoint), '/images/generations?api-version=preview'), body);
        return { ...facts, 'request.http': move(request) };
      },
      response: async back => {
        const { http, outcome } = await parseResultBody(back, bytes => parseJsonObject(bytes), formatOpenAIImagesGenerationsError);
        const { 'response.transport': _transport, ...response } = back;
        return { ...response, 'response.http': move(http), 'response.modelKey': modelKey, 'response.openaiImagesGenerations': move(outcome) };
      },
    };
  }),
});

export const openaiImagesGenerations = compose('azure.openaiImagesGenerations', {
  entry: ['request.http', 'request.openaiImagesGenerations', 'provider.upstream', 'provider.model'],
  exit: ['response.http', 'response.modelKey', 'response.openaiImagesGenerations'],
  stages: [stripAzureHeaders, call],
  ending: httpTerminal,
});
