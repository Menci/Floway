import { customPath } from '../../endpoint.ts';
import { applyIngressHeaderRules } from '../apply-ingress-header-rules.ts';
import { parseJsonObject } from '../parse-json-object.ts';
import { prepareRequest, upstreamConfig } from '../prepare-request.ts';
import { factSpace, move, transform } from '@floway-dev/pipeline';
import { formatOpenAIImagesGenerationsError, isOpenAIImagesTerminalEvent, openAIImagesStreamRequested, parseOpenAIImagesStream } from '@floway-dev/protocols/openai-images';
import { httpTerminal, type ProviderOperationFacts, type ProviderTransportFacts, type ProviderServices, parseResultBody, parseSseBody } from '@floway-dev/provider';

const { compose, defineStage } = factSpace<ProviderOperationFacts<'openaiImagesGenerations'> & ProviderTransportFacts, ProviderServices>();

const call = defineStage({
  name: 'custom.openaiImagesGenerations.call',
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
  execute: transform(scope => {
    let modelKey: string;
    let stream: boolean;
    return {
      request: facts => {
        const config = upstreamConfig(facts['provider.upstream']);
        const { upstreamModelId } = facts['provider.model'];
        modelKey = upstreamModelId;
        stream = openAIImagesStreamRequested(facts['request.openaiImagesGenerations'].stream);
        const body = { ...facts['request.openaiImagesGenerations'], model: modelKey };
        const request = prepareRequest(facts['request.http'], config, customPath(config, '/images/generations'), body);
        return { ...facts, 'request.http': move(request) };
      },
      response: async back => {
        const { http, outcome } = stream
          ? await parseSseBody(back, scope, parseOpenAIImagesStream, { kind: 'terminalEvent' as const, isTerminal: isOpenAIImagesTerminalEvent }, formatOpenAIImagesGenerationsError)
          : await parseResultBody(back, bytes => parseJsonObject(bytes), formatOpenAIImagesGenerationsError);
        const { 'response.transport': _transport, ...response } = back;
        return { ...response, 'response.http': move(http), 'response.modelKey': modelKey, 'response.openaiImagesGenerations': move(outcome) };
      },
    };
  }),
});

export const openaiImagesGenerations = compose('custom.openaiImagesGenerations', {
  entry: ['request.http', 'request.openaiImagesGenerations', 'provider.upstream', 'provider.model'],
  exit: ['response.http', 'response.modelKey', 'response.openaiImagesGenerations'],
  stages: [applyIngressHeaderRules, call],
  ending: httpTerminal,
});
