import { customPath } from '../../endpoint.ts';
import { applyAnthropicMessagesIngressHeaderRules } from '../apply-ingress-header-rules.ts';
import { prepareRequest, upstreamConfig } from '../prepare-request.ts';
import { factSpace, move, transform } from '@floway-dev/pipeline';
import { formatAnthropicMessagesError, parseAnthropicMessagesStream } from '@floway-dev/protocols/anthropic-messages';
import { httpTerminal, type ProviderOperationFacts, type ProviderTransportFacts, type ProviderServices, parseSseBody } from '@floway-dev/provider';

const { compose, defineStage } = factSpace<ProviderOperationFacts<'anthropicMessages'> & ProviderTransportFacts, ProviderServices>();

const call = defineStage({
  name: 'custom.anthropicMessages.call',
  through: {
    request: {
      needs: ['request.http', 'request.anthropicMessages', 'provider.upstream', 'provider.model'],
      provides: ['request.http'],
      consumes: [],
    },
    response: {
      needs: ['response.transport'],
      provides: ['response.http', 'response.modelKey', 'response.anthropicMessages'],
      consumes: ['response.transport'],
    },
  },
  execute: transform(scope => {
    let modelKey: string;
    return {
      request: facts => {
        const config = upstreamConfig(facts['provider.upstream']);
        const { upstreamModelId } = facts['provider.model'];
        modelKey = upstreamModelId;
        const body = { ...facts['request.anthropicMessages'], model: modelKey, stream: true };
        const request = prepareRequest(facts['request.http'], config, customPath(config, '/messages'), body, { authStyle: 'x-api-key' });
        return { ...facts, 'request.http': move(request) };
      },
      response: async back => {
        const { http, outcome } = await parseSseBody(back, scope, parseAnthropicMessagesStream, { kind: 'terminalEvent', isTerminal: event => event.type === 'message_stop' || event.type === 'error' }, formatAnthropicMessagesError);
        const { 'response.transport': _transport, ...response } = back;
        return { ...response, 'response.http': move(http), 'response.modelKey': modelKey, 'response.anthropicMessages': move(outcome) };
      },
    };
  }),
});

export const anthropicMessages = compose('custom.anthropicMessages', {
  entry: ['request.http', 'request.anthropicMessages', 'provider.upstream', 'provider.model'],
  exit: ['response.http', 'response.modelKey', 'response.anthropicMessages'],
  stages: [applyAnthropicMessagesIngressHeaderRules, call],
  ending: httpTerminal,
});
