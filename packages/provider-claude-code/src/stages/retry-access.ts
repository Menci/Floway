import { ensureClaudeCodeAccessToken, invalidateClaudeCodeAccessToken } from '../access-token.ts';
import { ClaudeCodeOAuthSessionTerminatedError } from '../auth/oauth.ts';
import { synthetic503 } from '../fetch.ts';
import type { ClaudeCodeHttpRequest } from '../pipeline-facts.ts';
import { takeHttpResponse } from '@floway-dev/http/pipeline';
import { defineStage, move, secret } from '@floway-dev/pipeline';
import { getProviderRepo, replaceHttpHeader, type ProviderResponse, type ProviderChatServices } from '@floway-dev/provider';

export const retryClaudeCodeAccess = (upstreamId: string) => defineStage<ClaudeCodeHttpRequest, ClaudeCodeHttpRequest, ProviderResponse, ProviderResponse, ProviderChatServices>({
  name: 'retryClaudeCodeAccess',
  through: {
    request: { needs: ['request.claudeCode.access', 'request.http.callId', 'request.http.headers', 'request.provider.modelKey'], consumes: ['request.claudeCode.access', 'request.http.headers'], provides: ['request.claudeCode.access', 'request.http.headers'] },
    response: { needs: ['response.http.exchange', 'response.http.body', 'response.provider.previousCalls'], consumes: ['response.http.exchange', 'response.http.body'], provides: ['response.http.exchange', 'response.http.body', 'response.provider.previousCalls'] },
  },
  execute: async (facts, next, use) => {
    const first = await next(move({ ...facts }));
    const exchange = first['response.http.exchange'];
    if (exchange.type !== 'response' || exchange.status !== 401 || facts['request.claudeCode.access'].freshlyMinted) return move({ ...first });
    if (exchange.body !== null) await exchange.body[Symbol.asyncDispose]();
    const previous = [...first['response.provider.previousCalls'], { modelKey: first['response.provider.modelKey'] }];
    await invalidateClaudeCodeAccessToken({ upstreamId, repo: getProviderRepo().upstreams });
    let access;
    try {
      access = await ensureClaudeCodeAccessToken({ upstreamId, repo: getProviderRepo().upstreams, fetcher: use.httpCall(facts['request.http.callId']).fetcher });
    } catch (error) {
      if (!(error instanceof ClaudeCodeOAuthSessionTerminatedError)) throw error;
      const rejected = takeHttpResponse(synthetic503(`Claude Code refresh failed: ${error.upstreamMessage}`));
      return move({ ...first, 'response.http.exchange': rejected, 'response.http.body': rejected.body, 'response.provider.called': false, 'response.provider.previousCalls': previous });
    }
    const retried = await next(move({
      ...facts, 'request.claudeCode.access': { ...access, entry: { ...access.entry, token: secret(access.entry.token) } },
      'request.http.headers': replaceHttpHeader(facts['request.http.headers'], 'authorization', secret(`Bearer ${access.entry.token}`)),
    }));
    return move({ ...retried, 'response.provider.previousCalls': previous });
  },
});
