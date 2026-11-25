import { CHATGPT_ALPHA_SEARCH_PATH } from '../../constants.ts';
import { uuidV7 } from '../../ids.ts';
import { stringField } from '../../responses-request.ts';
import type { ChatGPTServices } from '../../service.ts';
import type { ChatGPTUpstreamFact } from '../../upstream-fact.ts';
import { authorizedCall, parseJsonObject, withoutTransportResponse } from '../authorized-call.ts';
import { codexRequest, trimHeader } from '../request.ts';
import { factSpace, move } from '@floway-dev/pipeline';
import { formatOpenAIResponsesError } from '@floway-dev/protocols/openai-responses';
import { parseResultBody, type ProviderOperationFacts, type ProviderTransportFacts } from '@floway-dev/provider';

export const { defineStage, compose } = factSpace<ProviderOperationFacts<'alphaSearch', ChatGPTUpstreamFact> & ProviderTransportFacts, ChatGPTServices>();

const output = ['response.http', 'response.modelKey', 'response.alphaSearch'] as const;

export const call = defineStage({
  name: 'chatgpt.call-alpha-search',
  through: {
    request: { needs: ['request.http', 'request.alphaSearch', 'provider.upstream', 'provider.model'], provides: ['request.http'], consumes: [] },
    response: { needs: ['response.transport'], provides: output, consumes: ['response.transport'] },
  },
  return: { provides: output },
  async execute(facts, scope) {
    const request = facts['request.http'];
    const payload = facts['request.alphaSearch'];
    const upstream = facts['provider.upstream'];
    const model = facts['provider.model'];
    const modelKey = model.upstreamModelId;
    const prepareRequest = () => {
      const id = stringField(payload, 'id') ?? uuidV7();
      return codexRequest(request, CHATGPT_ALPHA_SEARCH_PATH, { ...payload, id, model: modelKey }, 'application/json', {
        sessionId: id,
        threadId: id,
        clientRequestId: id,
        windowId: `${id}:0`,
      }, trimHeader(request.headers, 'x-codex-turn-metadata'), false);
    };
    const back = await authorizedCall(upstream, prepareRequest, false, scope,
      next => scope.next({ ...facts, 'request.http': next }), formatOpenAIResponsesError);
    const { http, outcome } = 'outcome' in back ? back : await parseResultBody(back, parseJsonObject, formatOpenAIResponsesError);
    return {
      ...withoutTransportResponse(back),
      'response.http': move(http),
      'response.modelKey': modelKey,
      'response.alphaSearch': move(outcome),
    };
  },
});
