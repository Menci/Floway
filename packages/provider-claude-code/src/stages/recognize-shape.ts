import { isClaudeCodeShapedRequest } from '../detection.ts';
import type { ClaudeCodeProviderData } from '../models.ts';
import type { ClaudeCodePreparedRequest, ClaudeCodeRequest } from '../pipeline-facts.ts';
import { defineStage, isSecret, move } from '@floway-dev/pipeline';
import { headersForAnthropicMessagesCall, type ProviderChatResponse } from '@floway-dev/provider';

export const recognizeClaudeCodeShape = defineStage<ClaudeCodeRequest, ClaudeCodePreparedRequest, ProviderChatResponse<'anthropicMessages'>, ProviderChatResponse<'anthropicMessages'>>({
  name: 'recognizeClaudeCodeShape',
  through: {
    request: { needs: ['request.provider.model', 'request.provider.payload', 'request.provider.anthropicBeta', 'request.http.headers'], consumes: [], provides: ['request.provider.modelKey', 'request.claudeCode.shaped'] },
    response: { needs: [], consumes: [], provides: [] },
  },
  execute: async (facts, next) => {
    const headers = facts['request.http.headers'].map(([name, value]): [string, string] => [name, isSecret(value) ? value.reveal() : value]);
    const shaped = isClaudeCodeShapedRequest({ headers: new Headers(headersForAnthropicMessagesCall(headers, facts['request.provider.anthropicBeta']).map(([name, value]) => [name, value])), body: { ...facts['request.provider.payload'], model: facts['request.provider.model'].id } });
    return move({ ...await next(move({ ...facts, 'request.claudeCode.shaped': shaped, 'request.provider.modelKey': (facts['request.provider.model'].providerData as ClaudeCodeProviderData).upstreamModelId })) });
  },
});
