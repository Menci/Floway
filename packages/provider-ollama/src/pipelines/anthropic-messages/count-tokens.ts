import type { OllamaServices } from '../../service.ts';
import { parseJsonObject } from '../parse-json-object.ts';
import { prepareRequest, upstreamConfig } from '../prepare-request.ts';
import { stripOllamaAnthropicMessagesHeaders } from '../strip-headers.ts';
import { factSpace, move, transform, type Result } from '@floway-dev/pipeline';
import { formatAnthropicMessagesError, type AnthropicMessagesCountTokensResult } from '@floway-dev/protocols/anthropic-messages';
import { httpTerminal, type ProviderOperationFacts, type ProviderTransportFacts, parseResultBody } from '@floway-dev/provider';

const { compose, defineStage } = factSpace<ProviderOperationFacts<'anthropicMessagesCountTokens'> & ProviderTransportFacts, OllamaServices>();

const call = defineStage({
  name: 'ollama.anthropicMessagesCountTokens.call',
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
  execute: transform(() => {
    let modelKey: string;
    return {
      request: facts => {
        const config = upstreamConfig(facts['provider.upstream']);
        const { upstreamModelId } = facts['provider.model'];
        modelKey = upstreamModelId;
        const body = { ...facts['request.anthropicMessages'], model: modelKey };
        // https://docs.ollama.com/api/anthropic-compatibility
        const request = prepareRequest(facts['request.http'], config, '/v1/messages/count_tokens', body);
        return { ...facts, 'request.http': move(request) };
      },
      response: async back => {
        const { http, outcome } = await parseResultBody(back, parseCountTokens, formatAnthropicMessagesError);
        const { 'response.transport': _transport, ...response } = back;
        return { ...response, 'response.http': move(http), 'response.modelKey': modelKey, 'response.anthropicMessages': move(outcome) };
      },
    };
  }),
});

const parseCountTokens = (bytes: Uint8Array): Result<AnthropicMessagesCountTokensResult | null, unknown> => {
  if (bytes.byteLength === 0) return { ok: true, value: null };
  const json = parseJsonObject(bytes);
  if (!json.ok) return json;
  const { input_tokens } = json.value;
  if (typeof input_tokens !== 'number' || !Number.isFinite(input_tokens)) {
    return { ok: false, error: new TypeError('Expected a finite input_tokens count') };
  }
  return { ok: true, value: { ...json.value, input_tokens } };
};

export const anthropicMessagesCountTokens = compose('ollama.anthropicMessagesCountTokens', {
  entry: ['request.http', 'request.anthropicMessages', 'provider.upstream', 'provider.model'],
  exit: ['response.http', 'response.modelKey', 'response.anthropicMessages'],
  stages: [stripOllamaAnthropicMessagesHeaders, call],
  ending: httpTerminal,
});
