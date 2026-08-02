import { findCodexAccountIndex, readCodexUpstreamState, replaceCodexAccount } from './state.ts';
import { getProviderRepo } from '@floway-dev/provider';

export interface CodexQuotaSnapshot {
  observed_at: string;
  active_limit?: string;
  plan_type?: string;

  primary_used_percent?: number;
  primary_window_minutes?: number;
  primary_reset_after_at?: string;

  secondary_used_percent?: number;
  secondary_window_minutes?: number;
  secondary_reset_after_at?: string;

  credits_has_credits?: boolean;
  credits_balance?: number;

  // Present only when this snapshot was written as a result of a 429.
  ratelimited_until?: string;
}

export type CodexQuotaSnapshotMap = Record<string, CodexQuotaSnapshot>;

export const CODEX_QUOTA_UNKNOWN_ACTIVE_LIMIT = 'unknown';

const isUnsafeActiveLimitKey = (key: string): boolean => key === '__proto__' || key === 'constructor' || key === 'prototype';

export const codexQuotaActiveLimitKey = (snapshot: CodexQuotaSnapshot): string => {
  const key = snapshot.active_limit?.trim();
  return key && !isUnsafeActiveLimitKey(key) ? key : CODEX_QUOTA_UNKNOWN_ACTIVE_LIMIT;
};

const TTL_FLOOR_MS = 24 * 60 * 60 * 1000;

interface ParseCodexQuotaOptions {
  now: Date;
  isRateLimited: boolean;
}

export const parseCodexQuotaHeaders = (headers: Headers, options: ParseCodexQuotaOptions): CodexQuotaSnapshot => {
  const snapshot: CodexQuotaSnapshot = { observed_at: options.now.toISOString() };
  const assign = snapshot as unknown as Record<string, unknown>;

  const setString = (key: keyof CodexQuotaSnapshot, header: string): void => {
    const v = headers.get(header);
    if (v === null) return;
    const trimmed = v.trim();
    if (trimmed !== '') assign[key] = trimmed;
  };
  const setNumber = (key: keyof CodexQuotaSnapshot, header: string): void => {
    const v = headers.get(header);
    if (v === null) return;
    const n = Number(v);
    if (Number.isFinite(n)) assign[key] = n;
  };
  const setBool = (key: keyof CodexQuotaSnapshot, header: string): void => {
    const v = headers.get(header);
    if (v === null) return;
    const lower = v.toLowerCase();
    if (lower === 'true') assign[key] = true;
    else if (lower === 'false') assign[key] = false;
  };
  const setResetAfter = (key: keyof CodexQuotaSnapshot, header: string): void => {
    const v = headers.get(header);
    if (v === null) return;
    const seconds = Number(v);
    if (!Number.isFinite(seconds)) return;
    assign[key] = new Date(options.now.getTime() + seconds * 1000).toISOString();
  };

  setString('active_limit', 'x-codex-active-limit');
  setString('plan_type', 'x-codex-plan-type');
  setNumber('primary_used_percent', 'x-codex-primary-used-percent');
  setNumber('primary_window_minutes', 'x-codex-primary-window-minutes');
  setResetAfter('primary_reset_after_at', 'x-codex-primary-reset-after-seconds');
  setNumber('secondary_used_percent', 'x-codex-secondary-used-percent');
  setNumber('secondary_window_minutes', 'x-codex-secondary-window-minutes');
  setResetAfter('secondary_reset_after_at', 'x-codex-secondary-reset-after-seconds');
  setBool('credits_has_credits', 'x-codex-credits-has-credits');
  setNumber('credits_balance', 'x-codex-credits-balance');

  if (options.isRateLimited) {
    const primary = Number(headers.get('x-codex-primary-reset-after-seconds'));
    const secondary = Number(headers.get('x-codex-secondary-reset-after-seconds'));
    const seconds = Math.max(Number.isFinite(primary) ? primary : 0, Number.isFinite(secondary) ? secondary : 0);
    if (seconds > 0) {
      snapshot.ratelimited_until = new Date(options.now.getTime() + seconds * 1000).toISOString();
    }
  }

  return snapshot;
};

// Bound TTL by the furthest reset horizon to keep a hot account's state
// alive through its entire window; floor at 24h so dashboard reads survive
// quiet periods between bursts.
export const computeCodexQuotaTtlMs = (snapshot: CodexQuotaSnapshot, now: Date): number => {
  const horizons = [snapshot.primary_reset_after_at, snapshot.secondary_reset_after_at, snapshot.ratelimited_until]
    .map(s => s ? new Date(s).getTime() - now.getTime() : 0)
    .filter(ms => ms > 0);
  return Math.max(TTL_FLOOR_MS, ...horizons);
};

// Returns all fresh quota snapshots keyed by active limit. Stale buckets read as
// absent — the next upstream response for that active limit will overwrite it.
// state_json is unbounded, so freshness is gated inline by
// computeCodexQuotaTtlMs.
export const getCodexQuota = async (
  upstreamId: string,
  accountId: string,
): Promise<CodexQuotaSnapshotMap | null> => {
  const fresh = await getProviderRepo().upstreams.getById(upstreamId);
  if (!fresh) return null;
  const state = readCodexUpstreamState(fresh.state);
  const account = state.accounts.find(a => a.chatgptAccountId === accountId);
  if (!account?.quotaSnapshot) return null;
  const now = new Date();
  const freshSnapshots: CodexQuotaSnapshotMap = {};
  for (const [key, entry] of Object.entries(account.quotaSnapshot)) {
    const ttlMs = computeCodexQuotaTtlMs(entry.data, now);
    if (now.getTime() - entry.fetchedAt <= ttlMs) freshSnapshots[key] = entry.data;
  }
  return Object.keys(freshSnapshots).length ? freshSnapshots : null;
};

export const putCodexQuota = async (
  upstreamId: string,
  accountId: string,
  snapshot: CodexQuotaSnapshot,
): Promise<void> => {
  // Stamped before the write so a replay against a winning sibling produces
  // the same document rather than a later `fetchedAt`.
  const fetchedAt = Date.now();
  await getProviderRepo().upstreams.saveState(upstreamId, current => {
    const state = readCodexUpstreamState(current);
    const idx = findCodexAccountIndex(state, accountId);
    if (idx < 0) throw new Error(`putCodexQuota: Codex account ${accountId} not found in upstream ${upstreamId}`);
    return replaceCodexAccount(state, idx, account => ({
      ...account,
      quotaSnapshot: { ...account.quotaSnapshot ?? {}, [codexQuotaActiveLimitKey(snapshot)]: { fetchedAt, data: snapshot } },
    }));
  });
};
