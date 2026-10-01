import { ensureClaudeCodeAccessToken } from '../access-token.ts';
import { ClaudeCodeOAuthSessionTerminatedError } from '../auth/oauth.ts';
import { isRateLimitedNow, synthetic429, synthetic503 } from '../backend.ts';
import type { ClaudeCodeAuthenticatedRequest, ClaudeCodePreparedRequest } from '../pipeline-facts.ts';
import { readClaudeCodeUpstreamState } from '../state.ts';
import { takeHttpResponse } from '@floway-dev/http/pipeline';
import { defineStage, move, secret } from '@floway-dev/pipeline';
import { getProviderRepo, type ProviderChatResponse, type ProviderChatServices } from '@floway-dev/provider';

export const authenticateClaudeCode = (upstreamId: string) => defineStage<ClaudeCodePreparedRequest, ClaudeCodeAuthenticatedRequest, ProviderChatResponse<'anthropicMessages'>, ProviderChatResponse<'anthropicMessages'>, ProviderChatResponse<'anthropicMessages'>, ProviderChatServices>({
  name: 'authenticateClaudeCode',
  through: {
    request: { needs: ['request.provider.modelKey', 'request.http.callId'], consumes: [], provides: ['request.claudeCode.account', 'request.claudeCode.access'] },
    response: { needs: [], consumes: [], provides: [] },
  },
  return: { provides: ['response.http.exchange', 'response.http.body', 'response.provider.modelKey', 'response.provider.called', 'response.provider.previousCalls', 'response.provider.output'] },
  execute: async (facts, next, use) => {
    const fresh = await getProviderRepo().upstreams.getById(upstreamId);
    if (fresh === null) throw new Error(`Claude Code upstream ${upstreamId} disappeared mid-request`);
    const account = readClaudeCodeUpstreamState(fresh.state).accounts[0];
    const accountFacts = {
      ...account, refreshToken: account.refreshToken === null ? null : secret(account.refreshToken),
      accessToken: account.accessToken === null ? null : { ...account.accessToken, token: secret(account.accessToken.token) },
    };
    const reply = (response: Response) => {
      const exchange = takeHttpResponse(response);
      return move({
        ...facts, 'request.claudeCode.account': accountFacts, 'response.http.exchange': exchange, 'response.http.body': exchange.body,
        'response.provider.modelKey': facts['request.provider.modelKey'], 'response.provider.called': false,
        'response.provider.previousCalls': [], 'response.provider.output': null,
      });
    };
    if (account.state !== 'active') return reply(synthetic503(`Claude Code account is ${account.state}: ${account.stateMessage}`));
    const now = new Date();
    const quota = account.quotaSnapshot === null ? null : account.quotaSnapshot.data;
    if (isRateLimitedNow(quota, now)) return reply(synthetic429(quota.reset ? `Claude Code upstream rate-limited until ${quota.reset}` : 'Claude Code upstream rate-limited', quota.reset, now));
    const call = use.httpCall(facts['request.http.callId']);
    let access;
    try {
      access = await ensureClaudeCodeAccessToken({ upstreamId, repo: getProviderRepo().upstreams, fetcher: call.fetcher });
    } catch (error) {
      if (error instanceof ClaudeCodeOAuthSessionTerminatedError) return reply(synthetic503(`Claude Code refresh failed: ${error.upstreamMessage}`));
      throw error;
    }
    return move({ ...await next(move({ ...facts, 'request.claudeCode.account': accountFacts, 'request.claudeCode.access': { ...access, entry: { ...access.entry, token: secret(access.entry.token) } } })) });
  },
});
