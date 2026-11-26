import { defineStage } from '../../../pipeline/facts.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import type { FlagId } from '@floway-dev/provider';

export const anthropicMessagesPayloadStage = (
  name: string,
  shape: (payload: AnthropicMessagesPayload, flags: readonly FlagId[]) => AnthropicMessagesPayload,
) => defineStage({
  name: `anthropicMessages.${name}`,
  through: {
    request: { needs: ['request.anthropicMessages', 'provider.model'], provides: ['request.anthropicMessages'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: async (facts, scope) => await scope.next({
    ...facts,
    'request.anthropicMessages': shape(facts['request.anthropicMessages'], facts['provider.model'].enabledFlags),
  }),
});
