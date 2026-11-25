import type { KimiCodeServices } from '../../service.ts';
import { kimiCodeResponsesSpeedParser } from '../../speed.ts';
import type { KimiCodeUpstreamFact } from '../../upstream-fact.ts';
import { kimiCodeOpenAIModel, kimiCodeRequest } from '../request.ts';
import { factSpace, move } from '@floway-dev/pipeline';
import { formatOpenAIResponsesError, isOpenAIResponsesTerminalEvent, parseOpenAIResponsesStream } from '@floway-dev/protocols/openai-responses';
import { parseSseBody, type ProviderOperationFacts, type ProviderTransportFacts } from '@floway-dev/provider';

export const { defineStage, compose } = factSpace<ProviderOperationFacts<'openaiResponses', KimiCodeUpstreamFact> & ProviderTransportFacts, KimiCodeServices>();

const output = ['response.http', 'response.modelKey', 'response.openaiResponses'] as const;

export const call = defineStage({
  name: 'kimi-code.call-openai-responses',
  through: {
    request: { needs: ['request.http', 'request.openaiResponses', 'provider.upstream', 'provider.model'], provides: ['request.http'], consumes: [] },
    response: { needs: ['response.transport'], provides: output, consumes: ['response.transport'] },
  },
  return: { provides: output },
  async execute(facts, scope) {
    const model = facts['provider.model'];
    const payload = facts['request.openaiResponses'];
    const selection = kimiCodeOpenAIModel(model, payload.service_tier);
    if ('outcome' in selection) return {
      'response.http': move(selection.http),
      'response.modelKey': model.upstreamModelId,
      'response.openaiResponses': move(selection.outcome),
    };
    const request = kimiCodeRequest(facts['request.http'], facts['provider.upstream'], '/responses', { ...payload, ...(selection.tier === undefined ? {} : { service_tier: selection.tier }), model: selection.modelId, stream: true });
    const back = await scope.next({ ...facts, 'request.http': request });
    const parser = selection.tier === undefined ? parseOpenAIResponsesStream : kimiCodeResponsesSpeedParser(selection.tier);
    const { http, outcome } = await parseSseBody(back, scope, parser, { kind: 'terminalEvent', isTerminal: isOpenAIResponsesTerminalEvent }, formatOpenAIResponsesError);
    const { 'response.transport': _transport, ...response } = back;
    return {
      ...response,
      'response.http': move(http),
      'response.modelKey': selection.modelId,
      'response.openaiResponses': move(outcome),
    };
  },
});
