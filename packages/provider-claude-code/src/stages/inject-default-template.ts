import { injectDefaultTemplatePayload } from '../interceptors/anthropic-messages/inject-default-template.ts';
import type { ClaudeCodePreparedRequest } from '../pipeline-facts.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import type { ProviderChatResponse } from '@floway-dev/provider';

export const injectDefaultTemplate = defineStage<ClaudeCodePreparedRequest, ClaudeCodePreparedRequest, ProviderChatResponse<'anthropicMessages'>, ProviderChatResponse<'anthropicMessages'>>({
  name: 'injectDefaultTemplate',
  through: { request: { needs: ['request.provider.payload', 'request.claudeCode.shaped'], consumes: ['request.provider.payload'], provides: ['request.provider.payload'] }, response: { needs: [], consumes: [], provides: [] } },
  execute: async (facts, next) => move({ ...await next(move({ ...facts, 'request.provider.payload': facts['request.claudeCode.shaped'] ? facts['request.provider.payload'] : injectDefaultTemplatePayload(facts['request.provider.payload']) })) }),
});
