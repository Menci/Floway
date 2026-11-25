import type { OllamaServices } from '../../service.ts';
import { observeStreamingProbes } from '../observe-probes.ts';
import { prepareRequest, upstreamConfig } from '../prepare-request.ts';
import { stripOllamaHeaders } from '../strip-headers.ts';
import { renameOutputCap } from './rename-output-cap.ts';
import { normalizeDeepSeek } from './vendor-deepseek-normalize.ts';
import { normalizeKimi } from './vendor-kimi-normalize.ts';
import { normalizeQwen } from './vendor-qwen-normalize.ts';
import { factSpace, move, transform } from '@floway-dev/pipeline';
import { formatOpenAIChatCompletionsError, parseOpenAIChatCompletionsStream } from '@floway-dev/protocols/openai-chat-completions';
import { httpTerminal, type ProviderOperationFacts, type ProviderTransportFacts, parseSseBody } from '@floway-dev/provider';

const { compose, defineStage } = factSpace<ProviderOperationFacts<'openaiChatCompletions'> & ProviderTransportFacts, OllamaServices>();

const call = defineStage({
  name: 'ollama.openaiChatCompletions.call',
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
        // https://docs.ollama.com/api/openai-compatibility
        const request = prepareRequest(facts['request.http'], config, '/v1/chat/completions', body);
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

export const openaiChatCompletions = compose('ollama.openaiChatCompletions', {
  entry: ['request.http', 'request.openaiChatCompletions', 'provider.upstream', 'provider.model'],
  exit: ['response.http', 'response.modelKey', 'response.openaiChatCompletions'],
  stages: [normalizeDeepSeek, normalizeQwen, normalizeKimi, stripOllamaHeaders, renameOutputCap, call, observeStreamingProbes],
  ending: httpTerminal,
});
