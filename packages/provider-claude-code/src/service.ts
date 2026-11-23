import { ClaudeCodeOAuthRequestError, ClaudeCodeOAuthSessionTerminatedError, refreshClaudeCodeAccessToken } from './auth/oauth.ts';
import { logInfo, logWarn } from './log.ts';
import { claudeCodeRateLimitedUntil, isClaudeCodeQuotaHeader, parseClaudeCodeQuotaHeaders } from './quota.ts';
import { readClaudeCodeUpstreamState, replaceSoleAccount, type ClaudeCodeAccessTokenEntry, type ClaudeCodeAccountCredential } from './state.ts';
import type { TerminalSentinel } from './terminal-account.ts';
import { claudeCodeProbeMetrics, claudeCodeQuotaMetrics } from './upstream-metrics.ts';
import { fetchClaudeCodeUsageProbe, mergeClaudeCodeUsageProbe, type ClaudeCodeUsageProbeResult } from './usage-probe.ts';
import { snapshotError, type ErrorSnapshot } from '@floway-dev/pipeline';
import {
  getProviderRepo, isUpstreamTransportError, recordUpstreamMetrics, runScheduledUsageRefresh, UpstreamGoneError,
  type Fetcher, type HeaderEntry, type ProviderScheduledOptions, type ProviderServices, type UpstreamRecord, type UpstreamsRepoSlim,
} from '@floway-dev/provider';

export type PersistenceResult = { readonly persisted: true } | { readonly persisted: false; readonly error: ErrorSnapshot };

interface EnsuredAccessToken {
  readonly entry: ClaudeCodeAccessTokenEntry;
  // Every waiter sharing a mint observes a fresh token. A subsequent cache
  // hit can retry once if that token is rejected by Messages.
  readonly freshlyMinted: boolean;
}

interface EnsureClaudeCodeAccessTokenArgs {
  readonly upstreamId: string;
  readonly repo?: UpstreamsRepoSlim;
  readonly fetcher: Fetcher;
  readonly force?: boolean;
}

interface AccessOptions {
  readonly invalidate?: boolean;
  readonly rejectedToken?: string;
}

interface AccessError {
  readonly kind: 'error';
  readonly source: 'local' | 'upstream';
  readonly status: number;
  readonly headers: readonly HeaderEntry[];
  readonly error: { readonly error: { readonly type: string; readonly message: string; readonly retry_at?: string } };
  readonly transportError?: ErrorSnapshot;
}

type AccessResult = ({ readonly kind: 'access' } & EnsuredAccessToken) | AccessError;

export interface ClaudeCodeService {
  readonly access: (upstreamId: string, modelKey: string, fetcher: Fetcher, options?: AccessOptions) => Promise<AccessResult>;
  readonly saveQuota: (upstreamId: string, modelKey: string, status: number, headers: readonly HeaderEntry[]) => Promise<PersistenceResult>;
  readonly persistTerminalVerdict: (upstreamId: string, verdict: TerminalSentinel) => Promise<PersistenceResult>;
  readonly ensureAccessToken: (args: EnsureClaudeCodeAccessTokenArgs) => Promise<EnsuredAccessToken>;
  readonly persistUsageProbe: (upstreamId: string, probe: ClaudeCodeUsageProbeResult) => Promise<void>;
  readonly runScheduledTask: (record: UpstreamRecord, options: ProviderScheduledOptions) => Promise<void>;
}

export type ClaudeCodeServices = ProviderServices & { readonly claudeCode: ClaudeCodeService };

const REFRESH_SKEW_MS = 5 * 60 * 1000;

const isAccessTokenFresh = (entry: ClaudeCodeAccessTokenEntry): boolean =>
  entry.expiresAt > Date.now() + REFRESH_SKEW_MS;

const unavailable = (source: AccessError['source'], message: string): AccessError => ({
  kind: 'error',
  source,
  status: 503,
  headers: [],
  error: { error: { type: 'claude_code_upstream_unavailable', message } },
});

export const hasClaudeCodeQuota = (status: number, headers: readonly HeaderEntry[]): boolean =>
  ((status >= 200 && status < 300) || status === 429) && headers.some(([name]) => isClaudeCodeQuotaHeader(name));

const persist = async (
  event: string,
  upstreamId: string,
  work: () => Promise<void>,
): Promise<PersistenceResult> => {
  try {
    await work();
    return { persisted: true };
  } catch (error) {
    logWarn(event, { upstream_id: upstreamId, error: String(error) });
    return { persisted: false, error: snapshotError(error) };
  }
};

const persistTerminalState = async (
  repo: UpstreamsRepoSlim,
  upstreamId: string,
  message: string,
  fields: { readonly reason: string; readonly oauth_code?: string | null; readonly upstream_status?: number },
): Promise<void> => {
  // Preserve the first terminal diagnosis across replayed and concurrent writes.
  const flippedAt = new Date().toISOString();
  let previousAccount!: ClaudeCodeAccountCredential;
  await repo.saveState(upstreamId, current => {
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
    ...fields,
    message,
  });
};

const readAccount = async (repo: UpstreamsRepoSlim, upstreamId: string): Promise<ClaudeCodeAccountCredential | null> => {
  const record = await repo.getById(upstreamId);
  return record === null ? null : readClaudeCodeUpstreamState(record.state).accounts[0];
};

type OAuthAccount = Extract<ClaudeCodeAccountCredential, { tokenKind: 'oauth' }>;

const mintAccessToken = async (
  repo: UpstreamsRepoSlim,
  upstreamId: string,
  account: OAuthAccount,
  fetcher: Fetcher,
  recoveryAllowed: boolean,
): Promise<EnsuredAccessToken> => {
  let refreshed;
  try {
    refreshed = await refreshClaudeCodeAccessToken(account.refreshToken, fetcher);
  } catch (error) {
    if (error instanceof ClaudeCodeOAuthSessionTerminatedError) {
      if (error.code === 'invalid_grant' && recoveryAllowed) {
        const sibling = await readAccount(repo, upstreamId);
        if (sibling?.state === 'active' && sibling.tokenKind === 'oauth' && sibling.refreshToken !== account.refreshToken) {
          logInfo('claude_code_refresh_race_recovered', { upstream_id: upstreamId, account_uuid: sibling.accountUuid });
          if (sibling.accessToken && isAccessTokenFresh(sibling.accessToken)) {
            return { entry: sibling.accessToken, freshlyMinted: false };
          }
          return await mintAccessToken(repo, upstreamId, sibling, fetcher, false);
        }
      }
      await persistTerminalState(repo, upstreamId, error.upstreamMessage, { reason: 'oauth_refresh_failed', oauth_code: error.code });
    }
    throw error;
  }

  const now = Date.now();
  const entry: ClaudeCodeAccessTokenEntry = {
    token: refreshed.access_token,
    expiresAt: now + refreshed.expires_in * 1000,
    refreshedAt: new Date(now).toISOString(),
  };
  // Commit both rotated tokens in one write against the row that won the CAS.
  await repo.saveState(upstreamId, current =>
    replaceSoleAccount(readClaudeCodeUpstreamState(current), stored => (
      stored.state === 'active' && stored.tokenKind === 'oauth' && stored.refreshToken === account.refreshToken
        ? { ...stored, refreshToken: refreshed.refresh_token, accessToken: entry }
        : stored
    )));
  logInfo('claude_code_refresh_token_rotated', {
    upstream_id: upstreamId,
    account_uuid: account.accountUuid,
    expires_in_seconds: refreshed.expires_in,
    refreshed_at: entry.refreshedAt,
  });
  return { entry, freshlyMinted: true };
};

export const createClaudeCodeService = (getUpstreams = () => getProviderRepo().upstreams): ClaudeCodeService => {
  const inFlightMints = new Map<string, Promise<EnsuredAccessToken>>();

  const ensure = async (
    repo: UpstreamsRepoSlim,
    upstreamId: string,
    account: ClaudeCodeAccountCredential,
    fetcher: Fetcher,
    force: boolean,
    options?: AccessOptions,
  ): Promise<EnsuredAccessToken> => {
    if (account.state !== 'active') {
      throw new ClaudeCodeOAuthSessionTerminatedError({ code: account.state, message: account.stateMessage });
    }
    const invalidate = options?.invalidate === true
      && (options.rejectedToken === undefined || account.accessToken?.token === options.rejectedToken);
    if (account.tokenKind === 'setup-token') {
      if (account.accessToken && isAccessTokenFresh(account.accessToken) && !invalidate) {
        return { entry: account.accessToken, freshlyMinted: false };
      }
      const message = invalidate
        ? 'Setup token rejected by Anthropic; re-import to recover'
        : 'Setup token expired or absent; re-import to recover';
      const reason = invalidate ? 'setup_token_rejected' : 'setup_token_expired';
      await persistTerminalState(repo, upstreamId, message, { reason, oauth_code: null });
      throw new ClaudeCodeOAuthSessionTerminatedError({ code: reason, message });
    }

    const existing = inFlightMints.get(upstreamId);
    if (existing !== undefined) return await existing;
    if (account.accessToken && isAccessTokenFresh(account.accessToken) && !force && !invalidate) {
      return { entry: account.accessToken, freshlyMinted: false };
    }
    const mint = async (): Promise<EnsuredAccessToken> => {
      if (invalidate && account.accessToken !== null) {
        await repo.saveState(upstreamId, current =>
          replaceSoleAccount(readClaudeCodeUpstreamState(current), stored =>
            stored.accessToken?.token === account.accessToken?.token ? { ...stored, accessToken: null } : stored));
      }
      return await mintAccessToken(repo, upstreamId, account, fetcher, true);
    };
    const work = mint();
    inFlightMints.set(upstreamId, work);
    try {
      return await work;
    } finally {
      inFlightMints.delete(upstreamId);
    }
  };

  const ensureAccessToken: ClaudeCodeService['ensureAccessToken'] = async ({ upstreamId, repo = getUpstreams(), fetcher, force = false }) => {
    const account = await readAccount(repo, upstreamId);
    if (account === null) throw new UpstreamGoneError(upstreamId);
    return await ensure(repo, upstreamId, account, fetcher, force);
  };

  const persistUsageProbe: ClaudeCodeService['persistUsageProbe'] = async (upstreamId, probe) => {
    await getUpstreams().saveState(upstreamId, current => mergeClaudeCodeUsageProbe(readClaudeCodeUpstreamState(current), probe));
    await recordUpstreamMetrics(upstreamId, claudeCodeProbeMetrics(probe.body), Date.parse(probe.fetched_at));
  };

  return {
    async access(upstreamId, modelKey, fetcher, options) {
      const repo = getUpstreams();
      const account = await readAccount(repo, upstreamId);
      const missing = () => unavailable('local', `Claude Code upstream ${upstreamId} disappeared mid-request`);
      if (account === null) return missing();
      if (account.state !== 'active') return unavailable('local', `Claude Code account is ${account.state}: ${account.stateMessage}`);

      const now = Date.now();
      const reset = claudeCodeRateLimitedUntil(account.quotaSnapshot, now, modelKey);
      if (reset !== null) {
        const seconds = Math.max(0, Math.ceil((Date.parse(reset) - now) / 1000));
        return {
          kind: 'error',
          source: 'local',
          status: 429,
          headers: [['retry-after', String(seconds)]],
          error: { error: { type: 'claude_code_rate_limited', message: `Claude Code upstream rate-limited until ${reset}`, retry_at: reset } },
        };
      }

      try {
        return { kind: 'access', ...await ensure(repo, upstreamId, account, fetcher, false, options) };
      } catch (error) {
        if (error instanceof UpstreamGoneError) return missing();
        if (error instanceof ClaudeCodeOAuthSessionTerminatedError) return unavailable('upstream', `Claude Code refresh failed: ${error.upstreamMessage}`);
        if (error instanceof ClaudeCodeOAuthRequestError) return unavailable('upstream', error.message);
        if (!isUpstreamTransportError(error)) throw error;
        return {
          kind: 'error',
          source: 'upstream',
          status: 502,
          headers: [],
          error: { error: { type: 'upstream_transport_error', message: error.message } },
          transportError: snapshotError(error),
        };
      }
    },
    async saveQuota(upstreamId, modelKey, status, headers) {
      if (!hasClaudeCodeQuota(status, headers)) return { persisted: true };
      const quotaHeaders = new Headers();
      for (const [name, value] of headers) {
        if (isClaudeCodeQuotaHeader(name)) quotaHeaders.append(name, typeof value === 'string' ? value : value.reveal());
      }
      const snapshot = parseClaudeCodeQuotaHeaders(quotaHeaders);
      return await persist('claude_code_quota_persist_failed', upstreamId, async () => {
        const fetchedAt = Date.now();
        let previousAccount!: ClaudeCodeAccountCredential;
        await getUpstreams().saveState(upstreamId, current => {
          const state = readClaudeCodeUpstreamState(current);
          previousAccount = state.accounts[0];
          return replaceSoleAccount(state, account => ({
            ...account,
            quotaSnapshot: { fetchedAt, modelId: modelKey, data: snapshot },
          }));
        });
        await recordUpstreamMetrics(upstreamId, claudeCodeQuotaMetrics(snapshot), fetchedAt);
        const priorStatus = previousAccount.quotaSnapshot?.data.status ?? null;
        if (priorStatus !== snapshot.status) {
          logInfo('claude_code_quota_state_transition', {
            upstream_id: upstreamId,
            account_uuid: previousAccount.accountUuid,
            from_status: priorStatus,
            to_status: snapshot.status,
            reset_at_iso: snapshot.reset,
            representative_claim: snapshot.representativeClaim,
            model: modelKey,
          });
        }
      });
    },
    async persistTerminalVerdict(upstreamId, verdict) {
      const { message, reason, status } = verdict;
      logWarn('claude_code_terminal_sentinel_detected', { upstream_id: upstreamId, upstream_status: status, reason });
      return await persist('claude_code_terminal_sentinel_persist_failed', upstreamId, () =>
        persistTerminalState(getUpstreams(), upstreamId, message, { reason, upstream_status: status }));
    },
    ensureAccessToken,
    persistUsageProbe,
    async runScheduledTask(record, options) {
      const fresh = await getUpstreams().getById(record.id);
      if (fresh === null) return;
      const account = readClaudeCodeUpstreamState(fresh.state).accounts[0];
      // Setup tokens carry user:inference. The usage endpoint requires user:profile.
      // https://github.com/Wei-Shaw/sub2api/blob/3a6fd1c9db07203ca308aaba69e502bc1f35b307/backend/internal/service/account_usage_service.go#L477-L491
      if (account.state !== 'active' || account.tokenKind !== 'oauth') return;
      await runScheduledUsageRefresh(fresh, options, account.usageProbeSnapshot?.fetchedAt ?? null, async (target, fetcher) => {
        const access = await ensureAccessToken({ upstreamId: target.id, fetcher });
        const probe = await fetchClaudeCodeUsageProbe(access.entry.token, fetcher);
        await persistUsageProbe(target.id, probe);
      });
    },
  };
};

export const claudeCodeService = createClaudeCodeService();
export const ensureClaudeCodeAccessToken = claudeCodeService.ensureAccessToken;
export const persistClaudeCodeUsageProbe = claudeCodeService.persistUsageProbe;
