import { customPath } from '../../endpoint.ts';
import { applyIngressHeaderRules } from '../apply-ingress-header-rules.ts';
import { parseJsonObject } from '../parse-json-object.ts';
import { prepareRequest, upstreamConfig } from '../prepare-request.ts';
import { factSpace, move, transform } from '@floway-dev/pipeline';
import { formatAlphaSearchError } from '@floway-dev/protocols/alpha-search';
import { httpTerminal, type ProviderOperationFacts, type ProviderTransportFacts, type ProviderServices, parseResultBody } from '@floway-dev/provider';

const { compose, defineStage } = factSpace<ProviderOperationFacts<'alphaSearch'> & ProviderTransportFacts, ProviderServices>();

const call = defineStage({
  name: 'custom.alphaSearch.call',
  through: {
    request: {
      needs: ['request.http', 'request.alphaSearch', 'provider.upstream', 'provider.model'],
      provides: ['request.http'],
      consumes: [],
    },
    response: {
      needs: ['response.transport'],
      provides: ['response.http', 'response.modelKey', 'response.alphaSearch'],
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
        const body = { ...facts['request.alphaSearch'], model: modelKey };
        const request = prepareRequest(facts['request.http'], config, customPath(config, '/alpha/search'), body);
        return { ...facts, 'request.http': move(request) };
      },
      response: async back => {
        const { http, outcome } = await parseResultBody(back, bytes => parseJsonObject(bytes), formatAlphaSearchError);
        const { 'response.transport': _transport, ...response } = back;
        return { ...response, 'response.http': move(http), 'response.modelKey': modelKey, 'response.alphaSearch': move(outcome) };
      },
    };
  }),
});

export const alphaSearch = compose('custom.alphaSearch', {
  entry: ['request.http', 'request.alphaSearch', 'provider.upstream', 'provider.model'],
  exit: ['response.http', 'response.modelKey', 'response.alphaSearch'],
  stages: [applyIngressHeaderRules, call],
  ending: httpTerminal,
});
