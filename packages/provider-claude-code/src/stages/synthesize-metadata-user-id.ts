import { synthesizeMetadataUserIdPayload } from '../interceptors/anthropic-messages/synthesize-metadata-user-id.ts';
import type { ClaudeCodePreparedRequest } from '../pipeline-facts.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import type { ProviderChatResponse } from '@floway-dev/provider';

export const synthesizeMetadataUserId = (upstreamId: string) => defineStage<ClaudeCodePreparedRequest, ClaudeCodePreparedRequest, ProviderChatResponse<'anthropicMessages'>, ProviderChatResponse<'anthropicMessages'>>({
  name: 'synthesizeMetadataUserId',
  through: { request: { needs: ['request.provider.payload', 'request.claudeCode.shaped'], consumes: ['request.provider.payload'], provides: ['request.provider.payload'] }, response: { needs: [], consumes: [], provides: [] } },
  execute: async (facts, next) => move({ ...await next(move({ ...facts, 'request.provider.payload': facts['request.claudeCode.shaped'] ? facts['request.provider.payload'] : synthesizeMetadataUserIdPayload(facts['request.provider.payload'], upstreamId) })) }),
});
