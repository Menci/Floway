import type { ClaudeCodePreparedRequest } from '../pipeline-facts.ts';
import { IDENTITY_BLOCK } from '../system-blocks.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import type { AnthropicMessagesPayload, AnthropicMessagesTextBlock } from '@floway-dev/protocols/anthropic-messages';
import type { ProviderChatResponse } from '@floway-dev/provider';

// system[1]; relies on injectBillingBlock having materialized payload.system as an array (see ../pipelines.ts chain order).
export const injectIdentityBlockPayload = <P extends Omit<AnthropicMessagesPayload, 'model'>>(payload: P): P => {
  const system = payload.system as AnthropicMessagesTextBlock[];
  payload = { ...payload, system: [...system, IDENTITY_BLOCK] };
  return payload;
};

export const injectIdentityBlock = defineStage<ClaudeCodePreparedRequest, ClaudeCodePreparedRequest, ProviderChatResponse<'anthropicMessages'>, ProviderChatResponse<'anthropicMessages'>>({
  name: 'injectIdentityBlock',
  through: { request: { needs: ['request.provider.payload', 'request.claudeCode.shaped'], consumes: ['request.provider.payload'], provides: ['request.provider.payload'] }, response: { needs: [], consumes: [], provides: [] } },
  execute: async (facts, next) => move({ ...await next(move({ ...facts, 'request.provider.payload': facts['request.claudeCode.shaped'] ? facts['request.provider.payload'] : injectIdentityBlockPayload(facts['request.provider.payload']) })) }),
});
