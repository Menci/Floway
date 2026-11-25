import type { OllamaServices } from '../../service.ts';
import { observeStreamingProbes } from '../observe-probes.ts';
import { prepareRequest, upstreamConfig } from '../prepare-request.ts';
import { stripOllamaHeaders } from '../strip-headers.ts';
import { normalizeDeepSeek } from './vendor-deepseek-normalize.ts';
import { normalizeQwen } from './vendor-qwen-normalize.ts';
import { factSpace, move, transform } from '@floway-dev/pipeline';
import { formatOpenAIResponsesError, parseOpenAIResponsesStream, isOpenAIResponsesTerminalEvent, isOpenAIResponsesErrorEvent } from '@floway-dev/protocols/openai-responses';
import { httpTerminal, type ProviderOperationFacts, type ProviderTransportFacts, parseSseBody } from '@floway-dev/provider';

const { compose, defineStage } = factSpace<ProviderOperationFacts<'openaiResponses'> & ProviderTransportFacts, OllamaServices>();

const call = defineStage({
  name: 'ollama.openaiResponses.call',
  through: {
    request: {
      needs: ['request.http', 'request.openaiResponses', 'provider.upstream', 'provider.model'],
      provides: ['request.http'],
      consumes: [],
    },
    response: {
      needs: ['response.transport'],
      provides: ['response.http', 'response.modelKey', 'response.openaiResponses'],
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
        const body = { ...facts['request.openaiResponses'], model: modelKey, stream: true };
        // https://docs.ollama.com/api/openai-compatibility
        const request = prepareRequest(facts['request.http'], config, '/v1/responses', body);
        return { ...facts, 'request.http': move(request) };
      },
      response: async back => {
        const { http, outcome } = await parseSseBody(back, scope, parseOpenAIResponsesStream, { kind: 'terminalEvent', isTerminal: event => isOpenAIResponsesTerminalEvent(event) || isOpenAIResponsesErrorEvent(event) }, formatOpenAIResponsesError);
        const { 'response.transport': _transport, ...response } = back;
        return { ...response, 'response.http': move(http), 'response.modelKey': modelKey, 'response.openaiResponses': move(outcome) };
      },
    };
  }),
});

export const openaiResponses = compose('ollama.openaiResponses', {
  entry: ['request.http', 'request.openaiResponses', 'provider.upstream', 'provider.model'],
  exit: ['response.http', 'response.modelKey', 'response.openaiResponses'],
  stages: [normalizeDeepSeek, normalizeQwen, stripOllamaHeaders, call, observeStreamingProbes],
  ending: httpTerminal,
});
