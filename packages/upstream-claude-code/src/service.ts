import { ensureClaudeCodeAccessToken, invalidateClaudeCodeAccessToken } from './access-token.ts';
import { ClaudeCodeOAuthSessionTerminatedError } from './auth/oauth.ts';
import { logInfo, logWarn } from './log.ts';
import { claudeCodeRateLimitedUntil, type ClaudeCodeQuotaSnapshot } from './quota.ts';
import { readClaudeCodeUpstreamState, replaceSoleAccount, type ClaudeCodeAccountCredential } from './state.ts';
import { claudeCodeQuotaMetrics } from './upstream-metrics.ts';
import type { Fetcher } from '@floway-dev/http';
import { secret, type Secret } from '@floway-dev/pipeline';
import { normalizeUpstreamMetricIdentity, type UpstreamHttpServices, type UpstreamRuntimeRepo } from '@floway-dev/upstream';

type Authorization =
  | { kind: 'authorized'; header: Secret<string>; freshlyMinted: boolean }
  | { kind: 'unavailable'; message: string };

type AuthorizationDecision = Authorization
  | { kind: 'rate-limited'; reset: string; retryAfterSeconds: number };

export interface ClaudeCodeService {
  authorize(upstreamId: string, modelId: string, fetcher: Fetcher): Promise<AuthorizationDecision>;
  refreshAfterUnauthorized(upstreamId: string, fetcher: Fetcher): Promise<Authorization>;
  persistQuota(upstreamId: string, modelId: string, snapshot: ClaudeCodeQuotaSnapshot, fetchedAt: number): Promise<void>;
  persistSentinel(upstreamId: string, message: string, status: 400 | 403): Promise<void>;
}

export interface ClaudeCodeServices extends UpstreamHttpServices {
  claudeCode: ClaudeCodeService;
}

export const createClaudeCodeService = (repo: UpstreamRuntimeRepo): ClaudeCodeService => {
  const { upstreams } = repo;

  const ensure = async (upstreamId: string, fetcher: Fetcher): Promise<Authorization> => {
    try {
      const { entry, freshlyMinted } = await ensureClaudeCodeAccessToken({ upstreamId, repo: upstreams, fetcher });
      return { kind: 'authorized', header: secret(entry.token).map(token => `Bearer ${token}`), freshlyMinted };
    } catch (error) {
      if (!(error instanceof ClaudeCodeOAuthSessionTerminatedError)) throw error;
      return { kind: 'unavailable', message: `Claude Code refresh failed: ${error.upstreamMessage}` };
    }
  };

  return {
    async authorize(upstreamId, modelId, fetcher) {
      const record = await upstreams.getById(upstreamId);
      if (record === null) throw new Error(`Claude Code upstream ${upstreamId} disappeared mid-request`);
      const account = readClaudeCodeUpstreamState(record.state).accounts[0];
      if (account.state !== 'active') {
        return { kind: 'unavailable', message: `Claude Code account is ${account.state}: ${account.stateMessage}` };
      }

      const now = Date.now();
      const reset = claudeCodeRateLimitedUntil(account.quotaSnapshot, now, modelId);
      if (reset !== null) {
        return { kind: 'rate-limited', reset, retryAfterSeconds: Math.ceil((Date.parse(reset) - now) / 1000) };
      }
      return await ensure(upstreamId, fetcher);
    },

    async refreshAfterUnauthorized(upstreamId, fetcher) {
      await invalidateClaudeCodeAccessToken({ upstreamId, repo: upstreams });
      return await ensure(upstreamId, fetcher);
    },

    async persistQuota(upstreamId, modelId, snapshot, fetchedAt) {
      let previousAccount!: ClaudeCodeAccountCredential;
      await upstreams.saveState(upstreamId, current => {
        const state = readClaudeCodeUpstreamState(current);
        previousAccount = state.accounts[0];
        if (previousAccount.quotaSnapshot !== null && previousAccount.quotaSnapshot.fetchedAt > fetchedAt) return state;
        return replaceSoleAccount(state, account => ({
          ...account,
          quotaSnapshot: { fetchedAt, modelId, data: snapshot },
        }));
      });
      await Promise.all(claudeCodeQuotaMetrics(snapshot).map(({ name, labels, value }) => {
        const identity = normalizeUpstreamMetricIdentity(name, labels);
        return repo.recordUpstreamMetric(upstreamId, identity.name, identity.labels, value, fetchedAt);
      }));
      const prior = previousAccount.quotaSnapshot;
      const priorStatus = prior === null ? null : prior.data.status;
      if (priorStatus === snapshot.status || (prior !== null && prior.fetchedAt > fetchedAt)) return;
      logInfo('claude_code_quota_state_transition', {
        upstream_id: upstreamId,
        account_uuid: previousAccount.accountUuid,
        from_status: priorStatus,
        to_status: snapshot.status,
        reset_at_iso: snapshot.reset,
        representative_claim: snapshot.representativeClaim,
        model: modelId,
      });
    },

    async persistSentinel(upstreamId, message, status) {
      const flippedAt = new Date().toISOString();
      const reason = status === 400 ? 'org_disabled_400_sentinel' : 'org_banned_403_sentinel';
      logWarn('claude_code_terminal_sentinel_detected', { upstream_id: upstreamId, upstream_status: status, reason });
      let previousAccount!: ClaudeCodeAccountCredential;
      await upstreams.saveState(upstreamId, current => {
        const state = readClaudeCodeUpstreamState(current);
        previousAccount = state.accounts[0];
        if (previousAccount.state !== 'active') return state;
        return replaceSoleAccount(state, account => ({
          ...account,
          state: 'refresh_failed',
          stateMessage: message,
          stateUpdatedAt: flippedAt,
          accessToken: null,
        }));
      });
      if (previousAccount.state !== 'active') return;
      logWarn('claude_code_account_state_flip', {
        upstream_id: upstreamId,
        account_uuid: previousAccount.accountUuid,
        from_state: previousAccount.state,
        to_state: 'refresh_failed',
        upstream_status: status,
        reason,
        message,
      });
    },
  };
};
