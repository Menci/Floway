import { backfillRequiredFieldsPayload } from '../interceptors/anthropic-messages/backfill-required-fields.ts';
import type { ClaudeCodePreparedRequest } from '../pipeline-facts.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import type { ProviderChatResponse } from '@floway-dev/provider';

export const backfillRequiredFields = defineStage<ClaudeCodePreparedRequest, ClaudeCodePreparedRequest, ProviderChatResponse<'anthropicMessages'>, ProviderChatResponse<'anthropicMessages'>>({
  name: 'backfillRequiredFields',
  through: { request: { needs: ['request.provider.payload', 'request.claudeCode.shaped', 'request.provider.model'], consumes: ['request.provider.payload'], provides: ['request.provider.payload'] }, response: { needs: [], consumes: [], provides: [] } },
  execute: async (facts, next) => move({ ...await next(move({ ...facts, 'request.provider.payload': facts['request.claudeCode.shaped'] ? facts['request.provider.payload'] : backfillRequiredFieldsPayload(facts['request.provider.payload'], facts['request.provider.model']) })) }),
});
