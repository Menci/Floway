import { createClaudeCodeAccessTokenEnsurer, invalidateClaudeCodeAccessToken, type EnsureClaudeCodeAccessTokenArgs, type EnsuredAccessToken } from './access-token.ts';
import { ClaudeCodeOAuthSessionTerminatedError } from './auth/oauth.ts';
import { claudeCodeLog, type ClaudeCodeLog } from './log.ts';
import { claudeCodeRateLimitedUntil, type ClaudeCodeQuotaSnapshot } from './quota.ts';
import { readClaudeCodeUpstreamState, replaceSoleAccount, type ClaudeCodeAccountCredential } from './state.ts';
import { claudeCodeQuotaMetrics } from './upstream-metrics.ts';
import { persistClaudeCodeUsageProbe, type ClaudeCodeUsageProbeResult } from './usage-probe.ts';
import type { ProviderFetcher } from '@floway-dev/http';
import { Secret } from '@floway-dev/pipeline';
import type { ProviderRepo, ProviderServices } from '@floway-dev/provider';

type Authorization =
  | { kind: 'authorized'; header: Secret<string>; freshlyMinted: boolean }
  | { kind: 'unavailable'; message: string };

type AuthorizationDecision = Authorization
  | { kind: 'rate-limited'; reset: string; retryAfterSeconds: number };

export interface ClaudeCodeService {
  ensureAccessToken(args: EnsureClaudeCodeAccessTokenArgs): Promise<EnsuredAccessToken>;
  persistUsageProbe(upstreamId: string, probe: ClaudeCodeUsageProbeResult): Promise<void>;
  authorize(upstreamId: string, modelId: string, fetcher: ProviderFetcher, log: ClaudeCodeLog): Promise<AuthorizationDecision>;
  refreshAfterUnauthorized(upstreamId: string, fetcher: ProviderFetcher, log: ClaudeCodeLog): Promise<Authorization>;
  persistQuota(upstreamId: string, modelId: string, snapshot: ClaudeCodeQuotaSnapshot, fetchedAt: number, log: ClaudeCodeLog): Promise<void>;
  persistSentinel(upstreamId: string, message: string, status: 400 | 403, log: ClaudeCodeLog): Promise<void>;
}

export interface ClaudeCodeServices extends ProviderServices {
  claudeCode: ClaudeCodeService;
}

export const createClaudeCodeService = (repo: ProviderRepo): ClaudeCodeService => {
  const { upstreams } = repo;
  const ensureAccessToken = createClaudeCodeAccessTokenEnsurer(upstreams);

  const ensure = async (upstreamId: string, fetcher: ProviderFetcher, log: ClaudeCodeLog): Promise<Authorization> => {
    try {
      const { entry, freshlyMinted } = await ensureAccessToken({
        upstreamId,
        fetcher: async (url, init) => (await fetcher(url, init)).response,
      }, log);
      return { kind: 'authorized', header: Secret.from(entry.token).map(token => `Bearer ${token}`), freshlyMinted };
    } catch (error) {
      if (!(error instanceof ClaudeCodeOAuthSessionTerminatedError)) throw error;
      return { kind: 'unavailable', message: `Claude Code refresh failed: ${error.upstreamMessage}` };
    }
  };

  return {
    ensureAccessToken: args => ensureAccessToken(args, claudeCodeLog),
    persistUsageProbe: (upstreamId, probe) => persistClaudeCodeUsageProbe(upstreamId, probe, repo),

    async authorize(upstreamId, modelId, fetcher, log) {
      const record = await upstreams.getById(upstreamId);
      if (!record) throw new Error(`Claude Code upstream ${upstreamId} disappeared mid-request`);
      const account = readClaudeCodeUpstreamState(record.state).accounts[0];
      if (account.state !== 'active') {
        return { kind: 'unavailable', message: `Claude Code account is ${account.state}: ${account.stateMessage}` };
      }

      const now = Date.now();
      const reset = claudeCodeRateLimitedUntil(account.quotaSnapshot, now, modelId);
      if (reset !== null) {
        return { kind: 'rate-limited', reset, retryAfterSeconds: Math.ceil((Date.parse(reset) - now) / 1000) };
      }
      return await ensure(upstreamId, fetcher, log);
    },

    async refreshAfterUnauthorized(upstreamId, fetcher, log) {
      await invalidateClaudeCodeAccessToken({ upstreamId, repo: upstreams });
      return await ensure(upstreamId, fetcher, log);
    },

    async persistQuota(upstreamId, modelId, snapshot, fetchedAt, log) {
      let previousAccount!: ClaudeCodeAccountCredential;
      await upstreams.saveState(upstreamId, current => {
        const state = readClaudeCodeUpstreamState(current);
        previousAccount = state.accounts[0];
        if (previousAccount.quotaSnapshot !== null && previousAccount.quotaSnapshot.fetchedAt > fetchedAt) return state;
        return replaceSoleAccount(state, account => ({ ...account, quotaSnapshot: { fetchedAt, modelId, data: snapshot } }));
      });
      await Promise.all(claudeCodeQuotaMetrics(snapshot).map(({ name, labels, value }) =>
        repo.recordUpstreamMetric(upstreamId, name, labels, value, fetchedAt)));
      const prior = previousAccount.quotaSnapshot;
      if (prior !== null && (prior.fetchedAt > fetchedAt || prior.data.status === snapshot.status)) return;
      if (prior === null && snapshot.status === null) return;
      log.withFields({
        upstream_id: upstreamId,
        account_uuid: previousAccount.accountUuid,
        from_status: prior?.data.status ?? null,
        to_status: snapshot.status,
        reset_at_iso: snapshot.reset,
        representative_claim: snapshot.representativeClaim,
        model: modelId,
      }).log('claude_code_quota_state_transition');
    },

    async persistSentinel(upstreamId, message, status, log) {
      const flippedAt = new Date().toISOString();
      const reason = status === 400 ? 'org_disabled_400_sentinel' : 'org_banned_403_sentinel';
      log.withFields({ upstream_id: upstreamId, upstream_status: status, reason }).warn('claude_code_terminal_sentinel_detected');
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
      log.withFields({
        upstream_id: upstreamId,
        account_uuid: previousAccount.accountUuid,
        from_state: previousAccount.state,
        to_state: 'refresh_failed',
        upstream_status: status,
        reason,
      }).warn('claude_code_account_state_flip');
    },
  };
};

export const ensureClaudeCodeAccessToken = (args: EnsureClaudeCodeAccessTokenArgs, claudeCode: ClaudeCodeService): Promise<EnsuredAccessToken> =>
  claudeCode.ensureAccessToken(args);
