import { CHATGPT_OPENAI_RESPONSES_COMPACT_PATH } from '../../constants.ts';
import { prepareChatGPTResponsesRequest } from '../../responses-request.ts';
import type { ChatGPTServices } from '../../service.ts';
import type { ChatGPTUpstreamFact } from '../../upstream-fact.ts';
import { authorizedCall, parseJsonObject, withoutTransportResponse } from '../authorized-call.ts';
import { codexRequest, trimHeader } from '../request.ts';
import { factSpace, move } from '@floway-dev/pipeline';
import { formatOpenAIResponsesError, type OpenAIResponsesCompactionResultEx } from '@floway-dev/protocols/openai-responses';
import { parseResultBody, type ProviderOperationFacts, type ProviderTransportFacts } from '@floway-dev/provider';

export const { defineStage, compose } = factSpace<ProviderOperationFacts<'openaiResponsesCompact', ChatGPTUpstreamFact> & ProviderTransportFacts, ChatGPTServices>();

const output = ['response.http', 'response.modelKey', 'response.openaiResponses'] as const;

export const call = defineStage({
  name: 'chatgpt.call-openai-responses-compact',
  through: {
    request: { needs: ['request.http', 'request.openaiResponses', 'provider.upstream', 'provider.model'], provides: ['request.http'], consumes: [] },
    response: { needs: ['response.transport'], provides: output, consumes: ['response.transport'] },
  },
  return: { provides: output },
  async execute(facts, scope) {
    const request = facts['request.http'];
    const payload = facts['request.openaiResponses'];
    const upstream = facts['provider.upstream'];
    const model = facts['provider.model'];
    const modelKey = model.upstreamModelId;
    const prepareRequest = (deviceId: string) => {
      const prepared = prepareChatGPTResponsesRequest({
        body: payload,
        model,
        modelKey,
        deviceId,
        getHeader: name => trimHeader(request.headers, name),
      }, 'compact');
      return codexRequest(request, CHATGPT_OPENAI_RESPONSES_COMPACT_PATH, prepared.body, 'application/json',
        prepared.identity, prepared.turnMetadataJson.header, prepared.responsesLite);
    };
    const back = await authorizedCall(upstream, prepareRequest, false, scope,
      next => scope.next({ ...facts, 'request.http': next }), formatOpenAIResponsesError);
    const { http, outcome } = 'outcome' in back ? back : await parseResultBody(back, parseCompaction, formatOpenAIResponsesError);
    return {
      ...withoutTransportResponse(back),
      'response.http': move(http),
      'response.modelKey': modelKey,
      'response.openaiResponses': move(outcome),
    };
  },
});

const parseCompaction = (bytes: Uint8Array) => {
  const data = parseJsonObject(bytes);
  if (!data.ok) return data;
  const { id, object, output } = data.value;
  if (typeof id !== 'string' || typeof object !== 'string' || !Array.isArray(output)) {
    return { ok: false, error: new TypeError('Expected an OpenAI Responses compact result') } as const;
  }
  return { ok: true, value: data.value as unknown as OpenAIResponsesCompactionResultEx } as const;
};
