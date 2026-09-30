import { hoistUserSystemToMessagesPayload } from '../interceptors/anthropic-messages/hoist-user-system-to-messages.ts';
import type { ClaudeCodePreparedRequest } from '../pipeline-facts.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import type { ProviderChatResponse } from '@floway-dev/provider';

export const hoistUserSystemToMessages = defineStage<ClaudeCodePreparedRequest, ClaudeCodePreparedRequest, ProviderChatResponse<'anthropicMessages'>, ProviderChatResponse<'anthropicMessages'>>({
  name: 'hoistUserSystemToMessages',
  through: { request: { needs: ['request.provider.payload', 'request.claudeCode.shaped'], consumes: ['request.provider.payload'], provides: ['request.provider.payload'] }, response: { needs: [], consumes: [], provides: [] } },
  execute: async (facts, next) => move({ ...await next(move({ ...facts, 'request.provider.payload': facts['request.claudeCode.shaped'] ? facts['request.provider.payload'] : hoistUserSystemToMessagesPayload(facts['request.provider.payload']) })) }),
});
