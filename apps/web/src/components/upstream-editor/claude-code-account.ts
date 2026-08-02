// Each window comes wholly from its newest snapshot; fields are never merged
// across header and probe sources, because the SDK keeps the windows separate:
// https://github.com/anthropics/claude-agent-sdk-python/blob/f8b9ec923982082a02c485924e0f60367949c3a1/src/claude_agent_sdk/types.py#L1270-L1300

import { HEAVY_USAGE_THRESHOLD_PERCENT, heaviestPercent } from './subscription-account-quota';
import type {
  ClaudeCodeAccountCredentialSummary,
  ClaudeCodeQuotaWindow,
  UpstreamRecord,
} from '../../api/types';

export type ClaudeCodeRecord = Extract<UpstreamRecord, { kind: 'claude-code' }>;

export const subscriptionLabel = (
  subscriptionType: 'pro' | 'max' | 'team' | 'enterprise' | null | undefined,
): string | null =>
  subscriptionType ? { pro: 'Pro', max: 'Max', team: 'Team', enterprise: 'Enterprise' }[subscriptionType] : null;

export type CredentialLookup =
  | { kind: 'present'; credential: ClaudeCodeAccountCredentialSummary }
  | { kind: 'uuid-mismatch'; expectedAccountUuid: string };

export const findCredential = (record: ClaudeCodeRecord): CredentialLookup => {
  const expectedAccountUuid = record.config.accounts[0].accountUuid;
  const match = record.state.accounts.find(account => account.accountUuid === expectedAccountUuid);
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
  // Normalized to 0..100 at the source boundary.
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
  const { credential } = lookup;
  if (credential.state === 'session_terminated') return { tone: 'danger', reason: 'session-terminated', detail: credential.stateMessage };
  if (credential.state === 'refresh_failed') return { tone: 'danger', reason: 'refresh-failed', detail: credential.stateMessage };
  // `rejected` on the primary status means a limit was hit; overage is a separate optional window.
  if (credential.quotaSnapshot?.data.status === 'rejected') return { tone: 'danger', reason: 'exhausted' };
  const heaviest = heaviestPercent(windows.map(row => row.percent));
  if (heaviest !== null && heaviest >= HEAVY_USAGE_THRESHOLD_PERCENT) return { tone: 'warning', reason: 'heavy', percent: Math.round(heaviest) };
  return { tone: 'success', reason: 'active' };
};

// Rejected optional overage pairs with `out_of_credits`, which is not actionable:
// https://github.com/anthropics/claude-agent-sdk-python/blob/f8b9ec923982082a02c485924e0f60367949c3a1/tests/test_rate_limit_event_repro.py#L48-L68
export const actionableDisabledReason = (credential: ClaudeCodeAccountCredentialSummary | null): string | null => {
  const reason = credential?.quotaSnapshot?.data.overage?.disabledReason ?? null;
  return reason === null || reason === 'out_of_credits' ? null : reason;
};

export const rawEntries = (source: Record<string, unknown> | undefined): [string, string][] =>
  Object.entries(source ?? {})
    .map(([key, value]): [string, string] => [key, typeof value === 'string' ? value : JSON.stringify(value)])
    .toSorted(([left], [right]) => left.localeCompare(right));
