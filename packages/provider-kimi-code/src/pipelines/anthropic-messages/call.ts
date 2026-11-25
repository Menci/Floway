import type { KimiCodeServices } from '../../service.ts';
import { kimiCodeMessagesSpeedParser, kimiCodeMessagesWireBody } from '../../speed.ts';
import type { KimiCodeUpstreamFact } from '../../upstream-fact.ts';
import { kimiCodeAnthropicMessagesModel, kimiCodeRequest } from '../request.ts';
import { factSpace, move } from '@floway-dev/pipeline';
import { formatAnthropicMessagesError, parseAnthropicMessagesStream } from '@floway-dev/protocols/anthropic-messages';
import { parseSseBody, type ProviderOperationFacts, type ProviderTransportFacts } from '@floway-dev/provider';

export const { defineStage, compose } = factSpace<ProviderOperationFacts<'anthropicMessages', KimiCodeUpstreamFact> & ProviderTransportFacts, KimiCodeServices>();

const output = ['response.http', 'response.modelKey', 'response.anthropicMessages'] as const;

export const call = defineStage({
  name: 'kimi-code.call-anthropic-messages',
  through: {
    request: { needs: ['request.http', 'request.anthropicMessages', 'provider.upstream', 'provider.model'], provides: ['request.http'], consumes: [] },
    response: { needs: ['response.transport'], provides: output, consumes: ['response.transport'] },
  },
  return: { provides: output },
  async execute(facts, scope) {
    const model = facts['provider.model'];
    const payload = facts['request.anthropicMessages'];
    const selection = kimiCodeAnthropicMessagesModel(model, payload.speed);
    if ('outcome' in selection) return {
      'response.http': move(selection.http),
      'response.modelKey': model.upstreamModelId,
      'response.anthropicMessages': move(selection.outcome),
    };
    const request = kimiCodeRequest(facts['request.http'], facts['provider.upstream'], '/messages', { ...kimiCodeMessagesWireBody(payload), model: selection.modelId, stream: true });
    const back = await scope.next({ ...facts, 'request.http': request });
    const speed = payload.speed === 'fast' ? 'fast' : payload.speed === 'standard' ? 'standard' : undefined;
    const parser = speed === undefined ? parseAnthropicMessagesStream : kimiCodeMessagesSpeedParser(speed);
    const { http, outcome } = await parseSseBody(back, scope, parser, { kind: 'terminalEvent', isTerminal: event => event.type === 'message_stop' || event.type === 'error' }, formatAnthropicMessagesError);
    const { 'response.transport': _transport, ...response } = back;
    return {
      ...response,
      'response.http': move(http),
      'response.modelKey': selection.modelId,
      'response.anthropicMessages': move(outcome),
    };
  },
});
