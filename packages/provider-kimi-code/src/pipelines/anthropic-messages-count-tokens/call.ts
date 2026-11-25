import type { KimiCodeServices } from '../../service.ts';
import { kimiCodeMessagesWireBody } from '../../speed.ts';
import type { KimiCodeUpstreamFact } from '../../upstream-fact.ts';
import { kimiCodeAnthropicMessagesModel, kimiCodeRequest } from '../request.ts';
import { factSpace, move } from '@floway-dev/pipeline';
import { formatAnthropicMessagesError, type AnthropicMessagesCountTokensResult } from '@floway-dev/protocols/anthropic-messages';
import { parseJsonBody, parseResultBody, type ProviderOperationFacts, type ProviderTransportFacts } from '@floway-dev/provider';

export const { defineStage, compose } = factSpace<ProviderOperationFacts<'anthropicMessagesCountTokens', KimiCodeUpstreamFact> & ProviderTransportFacts, KimiCodeServices>();

const output = ['response.http', 'response.modelKey', 'response.anthropicMessages'] as const;

export const call = defineStage({
  name: 'kimi-code.call-anthropic-messages-count-tokens',
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
    const request = kimiCodeRequest(facts['request.http'], facts['provider.upstream'], '/messages/count_tokens', { ...kimiCodeMessagesWireBody(payload), model: selection.modelId });
    const back = await scope.next({ ...facts, 'request.http': request });
    const { http, outcome } = await parseResultBody(back, parseCountTokens, formatAnthropicMessagesError);
    const { 'response.transport': _transport, ...response } = back;
    return {
      ...response,
      'response.http': move(http),
      'response.modelKey': selection.modelId,
      'response.anthropicMessages': move(outcome),
    };
  },
});

const parseCountTokens = (bytes: Uint8Array) => {
  const result = parseJsonBody(bytes);
  if (!result.ok) return result;
  const { value } = result;
  if (typeof value !== 'object' || value === null || !('input_tokens' in value) || typeof value.input_tokens !== 'number') {
    return { ok: false, error: new TypeError('Expected an Anthropic Messages input token count') } as const;
  }
  return { ok: true, value: { ...value, input_tokens: value.input_tokens } satisfies AnthropicMessagesCountTokensResult } as const;
};
