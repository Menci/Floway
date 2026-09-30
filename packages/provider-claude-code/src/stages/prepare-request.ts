import { ANTHROPIC_MESSAGES_ENDPOINT } from '../fetch.ts';
import { pickClaudeCodeHeaders } from '../headers.ts';
import type { ClaudeCodeAuthenticatedRequest, ClaudeCodeHttpRequest } from '../pipeline-facts.ts';
import { defineStage, isSecret, move, secret } from '@floway-dev/pipeline';
import { headersForAnthropicMessagesCall, replaceHttpHeader, type ProviderChatResponse } from '@floway-dev/provider';

export const prepareClaudeCodeRequest = defineStage<ClaudeCodeAuthenticatedRequest, ClaudeCodeHttpRequest, ProviderChatResponse<'anthropicMessages'>, ProviderChatResponse<'anthropicMessages'>>({
  name: 'prepareClaudeCodeRequest',
  through: {
    request: { needs: ['request.provider.model', 'request.provider.modelKey', 'request.provider.payload', 'request.provider.anthropicBeta', 'request.claudeCode.shaped', 'request.claudeCode.access', 'request.http.headers'], consumes: ['request.provider.model', 'request.provider.payload', 'request.provider.anthropicBeta', 'request.http.headers'], provides: ['request.claudeCode.model', 'request.http.url', 'request.http.method', 'request.http.headers', 'request.http.body', 'request.http.encoding'] },
    response: { needs: [], consumes: [], provides: [] },
  },
  execute: async (facts, next) => {
    const { 'request.provider.model': model, 'request.provider.payload': payload, 'request.provider.anthropicBeta': beta, ...rest } = facts;
    let headers = facts['request.claudeCode.shaped']
      ? headersForAnthropicMessagesCall(facts['request.http.headers'].map(([name, value]): [string, string] => [name, isSecret(value) ? value.reveal() : value]), beta)
      : Object.entries(pickClaudeCodeHeaders(facts['request.provider.modelKey']));
    if (!headers.some(([name]) => name.toLowerCase() === 'content-type')) headers = [...headers, ['content-type', 'application/json']];
    return move({
      ...await next(move({
        ...rest,
        'request.claudeCode.model': model,
        'request.http.url': ANTHROPIC_MESSAGES_ENDPOINT, 'request.http.method': 'POST',
        'request.http.headers': replaceHttpHeader(headers, 'authorization', secret(`Bearer ${facts['request.claudeCode.access'].entry.token.reveal()}`)),
        'request.http.body': { ...payload, model: facts['request.provider.modelKey'], stream: true }, 'request.http.encoding': 'json' as const,
      })),
    });
  },
});
