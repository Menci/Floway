// Two snapshot sources sit on a Claude Code credential, populated by different
// paths:
//
// - `quotaSnapshot` is header-derived — the gateway parses every /v1/messages
//   response's `anthropic-ratelimit-unified-*` headers into a fixed schema.
// - `usageProbeSnapshot` is the verbatim body of an operator-driven probe
//   against Anthropic's `/api/oauth/usage` endpoint, keyed by `five_hour` /
//   `seven_day` / `seven_day_sonnet`. The field set evolves with the upstream
//   CLI version, so nothing here asserts the inner shape.
//
// When both carry a window, the newer `fetchedAt` wins: the probe is the
// official `/status` source and is freshest right after a refresh click, while
// the header-derived snapshot is freshest after any real model call. Fields
// are never merged across the two — they shape the same window differently and
// a half-and-half reading would mislead.

import type {
  ClaudeCodeAccountCredentialSummary,
  ClaudeCodeQuotaWindow,
  UpstreamRecord,
} from '../../api/types';

export type ClaudeCodeRecord = Extract<UpstreamRecord, { kind: 'claude-code' }>;

export const HEAVY_USAGE_THRESHOLD_PERCENT = 80;

// `subscriptionType` and `rateLimitTier` are independent fields per the
// upstream CLI: plan name vs. usage-multiplier tier.
const RATE_LIMIT_TIER_SUFFIX: Record<string, string> = {
  default_claude_max_5x: '5×',
  default_claude_max_20x: '20×',
};

export const formatSubscription = (
  subscriptionType: 'pro' | 'max' | 'team' | 'enterprise' | null | undefined,
  rateLimitTier: string | null | undefined,
): string | null => {
  if (!subscriptionType) return null;
  const base = { pro: 'Pro', max: 'Max', team: 'Team', enterprise: 'Enterprise' }[subscriptionType];
  if (subscriptionType !== 'max') return base;
  const suffix = rateLimitTier ? RATE_LIMIT_TIER_SUFFIX[rateLimitTier] : undefined;
  return suffix ? `${base} ${suffix}` : base;
};

export type CredentialLookup =
  | { kind: 'present'; credential: ClaudeCodeAccountCredentialSummary }
  | { kind: 'missing-state' }
  | { kind: 'uuid-mismatch'; expectedAccountUuid: string };

export const lookUpCredential = (record: ClaudeCodeRecord): CredentialLookup => {
  const state = record.state;
  if (state === null) return { kind: 'missing-state' };
  const expectedAccountUuid = record.config.accounts[0].accountUuid;
  const match = state.accounts.find(account => account.accountUuid === expectedAccountUuid);
  return match ? { kind: 'present', credential: match } : { kind: 'uuid-mismatch', expectedAccountUuid };
};

interface ProbeWindow {
  utilization: number | null;
  resetAt: string | null;
}

export interface ProbeSnapshot {
  fetchedAt: number;
  fiveHour: ProbeWindow | null;
  sevenDay: ProbeWindow | null;
  sevenDaySonnet: ProbeWindow | null;
  // The upstream JSON minus the three known windows. Surfaced verbatim so a
  // new field (`priorIsUsingOverage`, `hadPriorUtilizationData`, …) is visible
  // without a dashboard change.
  extras: Record<string, unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readProbeWindow = (raw: unknown): ProbeWindow | null => {
  if (!isRecord(raw)) return null;
  return {
    utilization: typeof raw.utilization === 'number' ? raw.utilization : null,
    resetAt: typeof raw.resets_at === 'string' ? raw.resets_at : null,
  };
};

export const readProbeSnapshot = (credential: ClaudeCodeAccountCredentialSummary | null): ProbeSnapshot | null => {
  const snapshot = credential?.usageProbeSnapshot;
  if (!snapshot || !isRecord(snapshot.data)) return null;
  const { five_hour, seven_day, seven_day_sonnet, ...extras } = snapshot.data;
  return {
    fetchedAt: snapshot.fetchedAt,
    fiveHour: readProbeWindow(five_hour),
    sevenDay: readProbeWindow(seven_day),
    sevenDaySonnet: readProbeWindow(seven_day_sonnet),
    extras,
  };
};

export type WindowKey = 'fiveHour' | 'sevenDay' | 'sevenDaySonnet';

export interface WindowRow {
  key: WindowKey;
  // 0..100 regardless of source: the response headers report utilization as a
  // 0..1 fraction while the probe reports the same metric pre-multiplied, so
  // rendering can stay scale-agnostic.
  percent: number;
  resetAt: string | null;
  status: string | null;
  source: 'header' | 'probe';
  fetchedAt: number;
}

const pickWindow = (
  key: WindowKey,
  headerWindow: ClaudeCodeQuotaWindow | null | undefined,
  headerFetchedAt: number | null,
  probeWindow: ProbeWindow | null | undefined,
  probeFetchedAt: number | null,
): WindowRow | null => {
  const headerUtilization = headerWindow?.utilization ?? null;
  const probeUtilization = probeWindow?.utilization ?? null;
  const preferProbe = probeUtilization !== null && probeFetchedAt !== null
    && (headerUtilization === null || headerFetchedAt === null || probeFetchedAt > headerFetchedAt);
  if (preferProbe && probeWindow && probeUtilization !== null && probeFetchedAt !== null) {
    return { key, percent: probeUtilization, resetAt: probeWindow.resetAt, status: null, source: 'probe', fetchedAt: probeFetchedAt };
  }
  if (headerWindow && headerUtilization !== null && headerFetchedAt !== null) {
    return { key, percent: headerUtilization * 100, resetAt: headerWindow.reset, status: headerWindow.status, source: 'header', fetchedAt: headerFetchedAt };
  }
  return null;
};

export const quotaWindows = (credential: ClaudeCodeAccountCredentialSummary | null): WindowRow[] => {
  const quota = credential?.quotaSnapshot?.data ?? null;
  const headerFetchedAt = credential?.quotaSnapshot?.fetchedAt ?? null;
  const probe = readProbeSnapshot(credential);
  const probeFetchedAt = probe?.fetchedAt ?? null;

  const rows: WindowRow[] = [];
  const fiveHour = pickWindow('fiveHour', quota?.fiveHour, headerFetchedAt, probe?.fiveHour, probeFetchedAt);
  if (fiveHour) rows.push(fiveHour);
  const sevenDay = pickWindow('sevenDay', quota?.sevenDay, headerFetchedAt, probe?.sevenDay, probeFetchedAt);
  if (sevenDay) rows.push(sevenDay);
  // `seven_day_sonnet` rides only on the probe; there is no header counterpart.
  const sonnet = probe?.sevenDaySonnet;
  const sonnetUtilization = sonnet?.utilization ?? null;
  if (sonnetUtilization !== null && probeFetchedAt !== null) {
    rows.push({ key: 'sevenDaySonnet', percent: sonnetUtilization, resetAt: sonnet?.resetAt ?? null, status: null, source: 'probe', fetchedAt: probeFetchedAt });
  }
  return rows;
};

export type AccountStatus =
  | { tone: 'danger'; reason: 'uuid-mismatch' | 'session-terminated' | 'refresh-failed' | 'exhausted'; detail?: string }
  | { tone: 'warning'; reason: 'heavy'; percent: number }
  | { tone: 'success'; reason: 'active' };

export const accountStatus = (lookup: CredentialLookup, windows: WindowRow[]): AccountStatus => {
  if (lookup.kind === 'uuid-mismatch') return { tone: 'danger', reason: 'uuid-mismatch' };
  const credential = lookup.kind === 'present' ? lookup.credential : null;
  if (credential?.state === 'session_terminated') return { tone: 'danger', reason: 'session-terminated', detail: credential.stateMessage };
  if (credential?.state === 'refresh_failed') return { tone: 'danger', reason: 'refresh-failed', detail: credential.stateMessage };
  // Primary `status: rejected` means the plan window itself is exhausted — the
  // upstream will 429 the next request. `overage.status: rejected` is NOT a
  // limit signal; it is the steady state for any plan account that has not
  // bought extra credits.
  if (credential?.quotaSnapshot?.data.status === 'rejected') return { tone: 'danger', reason: 'exhausted' };
  const heaviest = windows.length ? Math.max(...windows.map(row => row.percent)) : null;
  if (heaviest !== null && heaviest >= HEAVY_USAGE_THRESHOLD_PERCENT) return { tone: 'warning', reason: 'heavy', percent: Math.round(heaviest) };
  return { tone: 'success', reason: 'active' };
};

// `out_of_credits` is the steady-state pair of `overage.status: rejected` —
// every plan account without purchased credits reports it, so surfacing it
// would make the normal case look broken. Any other value (a code we have not
// seen, a future Anthropic signal) surfaces verbatim.
export const actionableDisabledReason = (credential: ClaudeCodeAccountCredentialSummary | null): string | null => {
  const reason = credential?.quotaSnapshot?.data.overage?.disabledReason ?? null;
  return reason === null || reason === 'out_of_credits' ? null : reason;
};

export const clampPercent = (percent: number): number => Math.max(0, Math.min(100, Math.round(percent)));

// JSON-stringify each value so a nested object stays readable in the raw
// disclosure.
export const rawEntries = (source: Record<string, unknown> | undefined): [string, string][] =>
  Object.entries(source ?? {})
    .map(([key, value]): [string, string] => [key, typeof value === 'string' ? value : JSON.stringify(value)])
    .toSorted(([left], [right]) => left.localeCompare(right));
