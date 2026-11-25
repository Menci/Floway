import { getClaudeCodeAccessTokenService, invalidateClaudeCodeAccessToken, type EnsuredAccessToken } from './access-token.ts';
import { logInfo, logWarn } from './log.ts';
import { claudeCodeRateLimitedUntil, type ClaudeCodeQuotaSnapshot } from './quota.ts';
import { readClaudeCodeUpstreamState, replaceSoleAccount, type ClaudeCodeAccountCredential } from './state.ts';
import { claudeCodeProbeMetrics, claudeCodeQuotaMetrics } from './upstream-metrics.ts';
import { mergeClaudeCodeUsageProbe, type ClaudeCodeUsageProbeResult } from './usage-probe.ts';
import { Secret } from '@floway-dev/pipeline';
import {
  getProviderRepo,
  normalizeUpstreamMetricIdentity,
  type Fetcher,
  type ProviderRepo,
  type ProviderServices,
  type UpstreamMetrics,
} from '@floway-dev/provider';

type RequestBlock =
  | { readonly kind: 'terminal'; readonly message: string }
  | { readonly kind: 'quota'; readonly resetAt: string };

interface Authorization {
  readonly bearer: Secret<string>;
  readonly freshlyMinted: boolean;
}

export type ClaudeCodePersistenceResult =
  | { readonly persisted: true }
  | { readonly persisted: false; readonly error: unknown };

export interface ClaudeCodeService {
  readonly requestBlock: (upstreamId: string, modelId: string, now: number) => Promise<RequestBlock | null>;
  readonly authorization: (upstreamId: string, fetcher: Fetcher) => Promise<Authorization>;
  readonly reauthorize: (upstreamId: string, rejectedBearer: Secret<string>, fetcher: Fetcher) => Promise<Authorization>;
  readonly persistQuota: (upstreamId: string, modelId: string, snapshot: ClaudeCodeQuotaSnapshot) => Promise<ClaudeCodePersistenceResult>;
  readonly persistTerminal: (upstreamId: string, status: 400 | 403, message: string) => Promise<ClaudeCodePersistenceResult>;
  readonly ensureAccessToken: ReturnType<typeof getClaudeCodeAccessTokenService>;
  readonly persistUsageProbe: (upstreamId: string, probe: ClaudeCodeUsageProbeResult) => Promise<void>;
}

export interface ClaudeCodeServices extends ProviderServices {
  readonly claudeCode: ClaudeCodeService;
}

export const createClaudeCodeService = (repo: ProviderRepo): ClaudeCodeService => {
  const ensureAccessToken = getClaudeCodeAccessTokenService(repo.upstreams);
  const authorization: ClaudeCodeService['authorization'] = async (upstreamId, fetcher) =>
    toAuthorization(await ensureAccessToken({ upstreamId, fetcher }));

  return {
    async requestBlock(upstreamId, modelId, now) {
      const current = await repo.upstreams.getById(upstreamId);
      if (!current) throw new Error(`Claude Code upstream ${upstreamId} disappeared mid-request`);
      const account = readClaudeCodeUpstreamState(current.state).accounts[0];
      if (account.state !== 'active') {
        return { kind: 'terminal', message: `Claude Code account is ${account.state}: ${account.stateMessage}` };
      }
      const resetAt = claudeCodeRateLimitedUntil(account.quotaSnapshot, now, modelId);
      return resetAt === null ? null : { kind: 'quota', resetAt };
    },
    authorization,
    async reauthorize(upstreamId, rejectedBearer, fetcher) {
      await invalidateClaudeCodeAccessToken({
        upstreamId,
        repo: repo.upstreams,
        rejectedAuthorization: rejectedBearer.reveal(),
      });
      return await authorization(upstreamId, fetcher);
    },
    async persistQuota(upstreamId, modelId, snapshot) {
      return await observePersistence('claude_code_quota_persist_failed', upstreamId, async () => {
        const fetchedAt = Date.now();
        let previousAccount!: ClaudeCodeAccountCredential;
        await repo.upstreams.saveState(upstreamId, current => {
          const state = readClaudeCodeUpstreamState(current);
          previousAccount = state.accounts[0];
          return replaceSoleAccount(state, account => ({
            ...account,
            quotaSnapshot: { fetchedAt, modelId, data: snapshot },
          }));
        });
        await recordMetrics(repo, upstreamId, claudeCodeQuotaMetrics(snapshot), fetchedAt);
        const priorStatus = previousAccount.quotaSnapshot?.data.status ?? null;
        if (priorStatus === snapshot.status) return;
        logInfo('claude_code_quota_state_transition', {
          upstream_id: upstreamId,
          account_uuid: previousAccount.accountUuid,
          from_status: priorStatus,
          to_status: snapshot.status,
          reset_at_iso: snapshot.reset,
          representative_claim: snapshot.representativeClaim,
          model: modelId,
        });
      });
    },
    async persistTerminal(upstreamId, status, message) {
      return await observePersistence('claude_code_terminal_sentinel_persist_failed', upstreamId, async () => {
        const flippedAt = new Date().toISOString();
        let previousAccount!: ClaudeCodeAccountCredential;
        await repo.upstreams.saveState(upstreamId, current => {
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
          reason: status === 400 ? 'org_disabled_400_sentinel' : 'org_banned_403_sentinel',
          upstream_status: status,
          message,
        });
      });
    },
    ensureAccessToken,
    async persistUsageProbe(upstreamId, probe) {
      await repo.upstreams.saveState(upstreamId, current =>
        mergeClaudeCodeUsageProbe(readClaudeCodeUpstreamState(current), probe));
      await recordMetrics(repo, upstreamId, claudeCodeProbeMetrics(probe.body), Date.parse(probe.fetched_at));
    },
  };
};

const toAuthorization = ({ entry, freshlyMinted }: EnsuredAccessToken): Authorization => ({
  bearer: Secret.from(entry.token).map(token => `Bearer ${token}`),
  freshlyMinted,
});

const observePersistence = async (
  event: string,
  upstreamId: string,
  persist: () => Promise<void>,
): Promise<ClaudeCodePersistenceResult> => {
  try {
    await persist();
    return { persisted: true };
  } catch (error) {
    logWarn(event, { upstream_id: upstreamId, error: String(error) });
    return { persisted: false, error };
  }
};

const recordMetrics = async (repo: ProviderRepo, upstreamId: string, metrics: UpstreamMetrics, timestamp: number): Promise<void> => {
  await Promise.all(metrics.map(({ name, labels, value }) => {
    const identity = normalizeUpstreamMetricIdentity(name, labels);
    return repo.recordUpstreamMetric(upstreamId, identity.name, identity.labels, value, timestamp);
  }));
};

export const persistClaudeCodeUsageProbe = async (upstreamId: string, probe: ClaudeCodeUsageProbeResult): Promise<void> =>
  await createClaudeCodeService(getProviderRepo()).persistUsageProbe(upstreamId, probe);
