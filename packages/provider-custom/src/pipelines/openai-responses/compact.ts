import { customPath } from '../../endpoint.ts';
import { applyIngressHeaderRules } from '../apply-ingress-header-rules.ts';
import { parseJsonObject } from '../parse-json-object.ts';
import { prepareRequest, upstreamConfig } from '../prepare-request.ts';
import { factSpace, move, transform, type Result } from '@floway-dev/pipeline';
import { formatOpenAIResponsesError, toCompactPayloadShape, type OpenAIResponsesCompactionResultEx } from '@floway-dev/protocols/openai-responses';
import { httpTerminal, type ProviderOperationFacts, type ProviderTransportFacts, type ProviderServices, parseResultBody } from '@floway-dev/provider';

const { compose, defineStage } = factSpace<ProviderOperationFacts<'openaiResponsesCompact'> & ProviderTransportFacts, ProviderServices>();

const call = defineStage({
  name: 'custom.openaiResponsesCompact.call',
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
  execute: transform(() => {
    let modelKey: string;
    return {
      request: facts => {
        const config = upstreamConfig(facts['provider.upstream']);
        const { upstreamModelId } = facts['provider.model'];
        modelKey = upstreamModelId;
        const body = { ...toCompactPayloadShape(facts['request.openaiResponses']), model: modelKey };
        const request = prepareRequest(facts['request.http'], config, `${customPath(config, '/responses')}/compact`, body);
        return { ...facts, 'request.http': move(request) };
      },
      response: async back => {
        const { http, outcome } = await parseResultBody(back, parseCompact, formatOpenAIResponsesError);
        const { 'response.transport': _transport, ...response } = back;
        return { ...response, 'response.http': move(http), 'response.modelKey': modelKey, 'response.openaiResponses': move(outcome) };
      },
    };
  }),
});

const parseCompact = (bytes: Uint8Array): Result<OpenAIResponsesCompactionResultEx, unknown> => {
  const json = parseJsonObject(bytes);
  if (!json.ok) return json;
  const { id, object, output } = json.value;
  if (typeof id !== 'string' || typeof object !== 'string' || !Array.isArray(output)) {
    return { ok: false, error: new TypeError('Malformed OpenAI Responses compact result') };
  }
  return { ok: true, value: { ...json.value, id, object, output } };
};

export const openaiResponsesCompact = compose('custom.openaiResponsesCompact', {
  entry: ['request.http', 'request.openaiResponses', 'provider.upstream', 'provider.model'],
  exit: ['response.http', 'response.modelKey', 'response.openaiResponses'],
  stages: [applyIngressHeaderRules, call],
  ending: httpTerminal,
});
