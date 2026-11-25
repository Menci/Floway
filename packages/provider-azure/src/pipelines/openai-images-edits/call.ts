import { azureOpenAiV1BaseUrl } from '../../endpoint.ts';
import { parseJsonObject } from '../parse-json-object.ts';
import { prepareRequest, upstreamConfig } from '../prepare-request.ts';
import { stripAzureHeaders } from '../strip-headers.ts';
import { factSpace, move, transform } from '@floway-dev/pipeline';
import { formatOpenAIImagesEditsError } from '@floway-dev/protocols/openai-images';
import { httpTerminal, type ProviderOperationFacts, type ProviderTransportFacts, type ProviderServices, joinBaseAndPath, serializeOpenAIImagesEditsHttpBody, parseResultBody } from '@floway-dev/provider';

const { compose, defineStage } = factSpace<ProviderOperationFacts<'openaiImagesEdits'> & ProviderTransportFacts, ProviderServices>();

const call = defineStage({
  name: 'azure.openaiImagesEdits.call',
  through: {
    request: {
      needs: ['request.http', 'request.openaiImagesEdits', 'provider.upstream', 'provider.model'],
      provides: ['request.http'],
      consumes: [],
    },
    response: {
      needs: ['response.transport'],
      provides: ['response.http', 'response.modelKey', 'response.openaiImagesEdits'],
      consumes: ['response.transport'],
    },
  },
  execute: transform(() => {
    let modelKey: string;
    return {
      request: async facts => {
        const config = upstreamConfig(facts['provider.upstream']);
        const { upstreamModelId } = facts['provider.model'];
        modelKey = upstreamModelId;
        const { body, contentType } = await serializeOpenAIImagesEditsHttpBody(facts['request.openaiImagesEdits'], modelKey);
        // https://learn.microsoft.com/en-us/azure/foundry/openai/reference-preview-latest
        const request = prepareRequest(facts['request.http'], config, joinBaseAndPath(azureOpenAiV1BaseUrl(config.endpoint), '/images/edits?api-version=preview'), body, { contentType });
        return { ...facts, 'request.http': move(request) };
      },
      response: async back => {
        const { http, outcome } = await parseResultBody(back, bytes => parseJsonObject(bytes), formatOpenAIImagesEditsError);
        const { 'response.transport': _transport, ...response } = back;
        return { ...response, 'response.http': move(http), 'response.modelKey': modelKey, 'response.openaiImagesEdits': move(outcome) };
      },
    };
  }),
});

export const openaiImagesEdits = compose('azure.openaiImagesEdits', {
  entry: ['request.http', 'request.openaiImagesEdits', 'provider.upstream', 'provider.model'],
  exit: ['response.http', 'response.modelKey', 'response.openaiImagesEdits'],
  stages: [stripAzureHeaders, call],
  ending: httpTerminal,
});
