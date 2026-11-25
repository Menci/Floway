import type { OllamaServices } from '../../service.ts';
import { observeStreamingProbes } from '../observe-probes.ts';
import { prepareRequest, upstreamConfig } from '../prepare-request.ts';
import { stripOllamaAnthropicMessagesHeaders } from '../strip-headers.ts';
import { factSpace, move, transform } from '@floway-dev/pipeline';
import { formatAnthropicMessagesError, parseAnthropicMessagesStream } from '@floway-dev/protocols/anthropic-messages';
import { httpTerminal, type ProviderOperationFacts, type ProviderTransportFacts, parseSseBody } from '@floway-dev/provider';

const { compose, defineStage } = factSpace<ProviderOperationFacts<'anthropicMessages'> & ProviderTransportFacts, OllamaServices>();

const call = defineStage({
  name: 'ollama.anthropicMessages.call',
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
        // https://docs.ollama.com/api/anthropic-compatibility
        const request = prepareRequest(facts['request.http'], config, '/v1/messages', body);
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

export const anthropicMessages = compose('ollama.anthropicMessages', {
  entry: ['request.http', 'request.anthropicMessages', 'provider.upstream', 'provider.model'],
  exit: ['response.http', 'response.modelKey', 'response.anthropicMessages'],
  stages: [stripOllamaAnthropicMessagesHeaders, call, observeStreamingProbes],
  ending: httpTerminal,
});
