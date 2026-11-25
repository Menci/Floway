import { customPath } from '../../endpoint.ts';
import { applyIngressHeaderRules } from '../apply-ingress-header-rules.ts';
import { prepareRequest, upstreamConfig } from '../prepare-request.ts';
import { factSpace, move, transform } from '@floway-dev/pipeline';
import { formatOpenAIChatCompletionsError, parseOpenAIChatCompletionsStream } from '@floway-dev/protocols/openai-chat-completions';
import { httpTerminal, type ProviderOperationFacts, type ProviderTransportFacts, type ProviderServices, parseSseBody } from '@floway-dev/provider';

const { compose, defineStage } = factSpace<ProviderOperationFacts<'openaiChatCompletions'> & ProviderTransportFacts, ProviderServices>();

const call = defineStage({
  name: 'custom.openaiChatCompletions.call',
  through: {
    request: {
      needs: ['request.http', 'request.openaiChatCompletions', 'provider.upstream', 'provider.model'],
      provides: ['request.http'],
      consumes: [],
    },
    response: {
      needs: ['response.transport'],
      provides: ['response.http', 'response.modelKey', 'response.openaiChatCompletions'],
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
        const body = { ...facts['request.openaiChatCompletions'], model: modelKey, stream: true };
        const request = prepareRequest(facts['request.http'], config, customPath(config, '/chat/completions'), body);
        return { ...facts, 'request.http': move(request) };
      },
      response: async back => {
        const { http, outcome } = await parseSseBody(back, scope, parseOpenAIChatCompletionsStream, { kind: 'complete' }, formatOpenAIChatCompletionsError);
        const { 'response.transport': _transport, ...response } = back;
        return { ...response, 'response.http': move(http), 'response.modelKey': modelKey, 'response.openaiChatCompletions': move(outcome) };
      },
    };
  }),
});

export const openaiChatCompletions = compose('custom.openaiChatCompletions', {
  entry: ['request.http', 'request.openaiChatCompletions', 'provider.upstream', 'provider.model'],
  exit: ['response.http', 'response.modelKey', 'response.openaiChatCompletions'],
  stages: [applyIngressHeaderRules, call],
  ending: httpTerminal,
});
