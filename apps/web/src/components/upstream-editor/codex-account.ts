// Codex groups primary/secondary windows by limit id while credits come from
// account-wide headers:
// https://github.com/openai/codex/blob/f2bee854a73666e1c3e922a853dda591b1a25fcf/codex-rs/codex-api/src/rate_limits.rs#L27-L100
// https://github.com/openai/codex/blob/f2bee854a73666e1c3e922a853dda591b1a25fcf/codex-rs/codex-api/src/rate_limits.rs#L217-L228

import type {
  CodexAccountCredentialState,
  CodexQuotaSnapshot,
  CodexQuotaSnapshotMap,
  UpstreamRecord,
} from '../../api/types';

export type CodexRecord = Extract<UpstreamRecord, { kind: 'codex' }>;

export const HEAVY_USAGE_THRESHOLD_PERCENT = 80;

export interface QuotaWindow {
  key: 'primary' | 'secondary';
  percent: number;
  resetAt: string | null;
  windowMinutes: number | null;
}

export interface QuotaEntry {
  key: string;
  label: string;
  observedAt: string;
  rateLimitedUntil: string | null;
  windows: QuotaWindow[];
}

export const findCredential = (record: CodexRecord): CodexAccountCredentialState | null => {
  return record.state.accounts.find(account => account.chatgptAccountId === record.config.accounts[0].chatgptAccountId) ?? null;
};

const window = (
  key: QuotaWindow['key'],
  percent: number | undefined,
  resetAt: string | undefined,
  windowMinutes: number | undefined,
): QuotaWindow | null => typeof percent === 'number' && Number.isFinite(percent)
  ? { key, percent, resetAt: resetAt ?? null, windowMinutes: windowMinutes ?? null }
  : null;

// A `ratelimited_until` in the past is a spent limit, not a live one — the
// account is usable again and the badge must not claim otherwise.
const stillRateLimited = (until: string | undefined, now: number): string | null =>
  typeof until === 'string' && new Date(until).getTime() > now ? until : null;

export const quotaEntries = (quota: CodexQuotaSnapshotMap | null | undefined, now: number): QuotaEntry[] =>
  Object.entries(quota ?? {})
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, snapshot]) => ({
      key,
      label: snapshot.active_limit ?? key,
      observedAt: snapshot.observed_at,
      rateLimitedUntil: stillRateLimited(snapshot.ratelimited_until, now),
      windows: [
        window('primary', snapshot.primary_used_percent, snapshot.primary_reset_after_at, snapshot.primary_window_minutes),
        window('secondary', snapshot.secondary_used_percent, snapshot.secondary_reset_after_at, snapshot.secondary_window_minutes),
      ].filter((entry): entry is QuotaWindow => entry !== null),
    }));

// The freshest limit observation carries the freshest account-wide credits.
export const latestCredits = (quota: CodexQuotaSnapshotMap | null | undefined): CodexQuotaSnapshot | null => {
  let newest: CodexQuotaSnapshot | null = null;
  let newestObservedAt = Number.NEGATIVE_INFINITY;
  for (const snapshot of Object.values(quota ?? {})) {
    if (snapshot.credits_balance === undefined && snapshot.credits_has_credits === undefined) continue;
    const observedAt = new Date(snapshot.observed_at).getTime();
    if (observedAt > newestObservedAt) {
      newest = snapshot;
      newestObservedAt = observedAt;
    }
  }
  return newest;
};

export type AccountStatus =
  | { tone: 'danger'; reason: 'session-terminated' | 'refresh-failed'; detail?: string }
  | { tone: 'danger'; reason: 'rate-limited'; until: string }
  | { tone: 'warning'; reason: 'heavy'; percent: number }
  | { tone: 'success'; reason: 'active' };

export const accountStatus = (credential: CodexAccountCredentialState | null, entries: QuotaEntry[]): AccountStatus => {
  if (credential?.state === 'session_terminated') return { tone: 'danger', reason: 'session-terminated', detail: credential.state_message };
  if (credential?.state === 'refresh_failed') return { tone: 'danger', reason: 'refresh-failed', detail: credential.state_message };
  const until = entries
    .map(entry => entry.rateLimitedUntil)
    .filter((value): value is string => value !== null)
    .toSorted((left, right) => new Date(right).getTime() - new Date(left).getTime())[0];
  if (until !== undefined) return { tone: 'danger', reason: 'rate-limited', until };
  const percents = entries.flatMap(entry => entry.windows.map(item => item.percent));
  const heaviest = percents.length ? Math.max(...percents) : null;
  if (heaviest !== null && heaviest >= HEAVY_USAGE_THRESHOLD_PERCENT) return { tone: 'warning', reason: 'heavy', percent: Math.round(heaviest) };
  return { tone: 'success', reason: 'active' };
};

export const shortAccountId = (id: string): string => id.length <= 18 ? id : `${id.slice(0, 8)}…${id.slice(-6)}`;
