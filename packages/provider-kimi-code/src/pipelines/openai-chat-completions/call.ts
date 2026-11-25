import type { KimiCodeServices } from '../../service.ts';
import { kimiCodeChatSpeedParser } from '../../speed.ts';
import { kimiCodeOpenAIModel, kimiCodeRequest } from '../request.ts';
import { factSpace, move } from '@floway-dev/pipeline';
import { formatOpenAIChatCompletionsError, parseOpenAIChatCompletionsStream } from '@floway-dev/protocols/openai-chat-completions';
import { parseSseBody, type ProviderOperationFacts, type ProviderTransportFacts } from '@floway-dev/provider';

export const { defineStage, compose } = factSpace<ProviderOperationFacts<'openaiChatCompletions'> & ProviderTransportFacts, KimiCodeServices>();

const output = ['response.http', 'response.modelKey', 'response.openaiChatCompletions'] as const;

export const call = defineStage({
  name: 'kimi-code.call-openai-chat-completions',
  through: {
    request: { needs: ['request.http', 'request.openaiChatCompletions', 'provider.upstream', 'provider.model'], provides: ['request.http'], consumes: [] },
    response: { needs: ['response.transport'], provides: output, consumes: ['response.transport'] },
  },
  return: { provides: output },
  async execute(facts, scope) {
    const model = facts['provider.model'];
    const payload = facts['request.openaiChatCompletions'];
    const selection = kimiCodeOpenAIModel(model, payload.service_tier);
    if ('outcome' in selection) return {
      'response.http': move(selection.http),
      'response.modelKey': model.upstreamModelId,
      'response.openaiChatCompletions': move(selection.outcome),
    };
    const request = kimiCodeRequest(facts['request.http'], facts['provider.upstream'], '/chat/completions', { ...payload, ...(selection.tier === undefined ? {} : { service_tier: selection.tier }), model: selection.modelId, stream: true });
    const back = await scope.next({ ...facts, 'request.http': request });
    const parser = selection.tier === undefined ? parseOpenAIChatCompletionsStream : kimiCodeChatSpeedParser(selection.tier);
    const { http, outcome } = await parseSseBody(back, scope, parser, { kind: 'complete' }, formatOpenAIChatCompletionsError);
    const { 'response.transport': _transport, ...response } = back;
    return {
      ...response,
      'response.http': move(http),
      'response.modelKey': selection.modelId,
      'response.openaiChatCompletions': move(outcome),
    };
  },
});
