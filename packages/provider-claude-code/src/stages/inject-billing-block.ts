import { injectBillingBlockPayload } from '../interceptors/anthropic-messages/inject-billing-block.ts';
import type { ClaudeCodePreparedRequest } from '../pipeline-facts.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import type { ProviderChatResponse } from '@floway-dev/provider';

export const injectBillingBlock = defineStage<ClaudeCodePreparedRequest, ClaudeCodePreparedRequest, ProviderChatResponse<'anthropicMessages'>, ProviderChatResponse<'anthropicMessages'>>({
  name: 'injectBillingBlock',
  through: { request: { needs: ['request.provider.payload', 'request.claudeCode.shaped'], consumes: ['request.provider.payload'], provides: ['request.provider.payload'] }, response: { needs: [], consumes: [], provides: [] } },
  execute: async (facts, next) => move({ ...await next(move({ ...facts, 'request.provider.payload': facts['request.claudeCode.shaped'] ? facts['request.provider.payload'] : injectBillingBlockPayload(facts['request.provider.payload']) })) }),
});
