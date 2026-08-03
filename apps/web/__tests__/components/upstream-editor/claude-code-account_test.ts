import { describe, expect, it } from 'vitest';

import type {
  ClaudeCodeAccountCredentialSummary,
  ClaudeCodeQuotaSnapshotData,
  UpstreamRecord,
} from '../../../src/api/types';
import {
  accountStatus,
  actionableDisabledReason,
  findCredential,
  quotaWindows,
  rawEntries,
  readProbeSnapshot,
  subscriptionLabel,
} from '../../../src/components/upstream-editor/claude-code-account';

type ClaudeCodeRecord = Extract<UpstreamRecord, { kind: 'claude-code' }>;

const ACCOUNT_UUID = '11111111-2222-3333-4444-555555555555';

const quotaData = (overrides: Partial<ClaudeCodeQuotaSnapshotData> = {}): ClaudeCodeQuotaSnapshotData => ({
  status: null,
  reset: null,
  fallbackAvailable: null,
  fallbackPercentage: null,
  representativeClaim: null,
  overage: null,
  fiveHour: null,
  sevenDay: null,
  raw: {},
  ...overrides,
});

const credential = (overrides: Partial<ClaudeCodeAccountCredentialSummary> = {}): ClaudeCodeAccountCredentialSummary => ({
  accountUuid: ACCOUNT_UUID,
  tokenKind: 'oauth',
  state: 'active',
  stateUpdatedAt: '2026-07-01T00:00:00.000Z',
  accessToken: null,
  quotaSnapshot: null,
  usageProbeSnapshot: null,
  ...overrides,
});

const record = (state: ClaudeCodeRecord['state']): ClaudeCodeRecord => ({
  id: 'up_1',
  kind: 'claude-code',
  name: 'Claude',
  enabled: true,
  hue: 210,
  sort_order: 0,
  proxy_fallback_list: null,
  model_prefix: null,
  disabled_public_model_ids: [],
  flag_overrides: {},
  modelsCache: { fetchedAt: null, lastError: null, models: null },
  config: { accounts: [{ email: null, accountUuid: ACCOUNT_UUID, subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' }] },
  state,
} as unknown as ClaudeCodeRecord);

describe('claude code subscription label', () => {
  it('names the plan and leaves the rate-limit tier to its own badge', () => {
    expect(subscriptionLabel('max')).toBe('Max');
    expect(subscriptionLabel('pro')).toBe('Pro');
    expect(subscriptionLabel('enterprise')).toBe('Enterprise');
    expect(subscriptionLabel(null)).toBeNull();
  });
});

describe('credential lookup', () => {
  it('reports a mismatch rather than falling back to whatever account is stored', () => {
    const lookup = findCredential(record({ accounts: [credential({ accountUuid: 'someone-else' })] }));
    expect(lookup).toEqual({ kind: 'uuid-mismatch', expectedAccountUuid: ACCOUNT_UUID });
  });
});

describe('quota windows', () => {
  it('rescales header utilization onto the probe percentage scale', () => {
    const windows = quotaWindows(credential({
      quotaSnapshot: { fetchedAt: 1000, data: quotaData({ fiveHour: { status: 'allowed', reset: '2026-07-01T05:00:00Z', utilization: 0.42 } }) },
    }));
    expect(windows).toEqual([
      { key: 'fiveHour', percent: 42, resetAt: '2026-07-01T05:00:00Z', status: 'allowed', source: 'header', fetchedAt: 1000 },
    ]);
  });

  it('prefers whichever source was fetched more recently, per window', () => {
    const withNewerProbe = quotaWindows(credential({
      quotaSnapshot: { fetchedAt: 1000, data: quotaData({ fiveHour: { status: null, reset: null, utilization: 0.1 } }) },
      usageProbeSnapshot: { fetchedAt: 2000, data: { five_hour: { utilization: 55, resets_at: '2026-07-01T05:00:00Z' } } },
    }));
    expect(withNewerProbe[0]).toMatchObject({ percent: 55, source: 'probe' });

    const withNewerHeaders = quotaWindows(credential({
      quotaSnapshot: { fetchedAt: 3000, data: quotaData({ fiveHour: { status: null, reset: null, utilization: 0.1 } }) },
      usageProbeSnapshot: { fetchedAt: 2000, data: { five_hour: { utilization: 55, resets_at: null } } },
    }));
    expect(withNewerHeaders[0]).toMatchObject({ percent: 10, source: 'header' });
  });

  it('never merges fields across the two sources', () => {
    // The probe wins the window, so it must also supply the reset — taking
    // the header's reset alongside the probe's percentage would describe a
    // window that never existed.
    const [window] = quotaWindows(credential({
      quotaSnapshot: { fetchedAt: 1000, data: quotaData({ fiveHour: { status: 'allowed', reset: '2026-07-01T05:00:00Z', utilization: 0.1 } }) },
      usageProbeSnapshot: { fetchedAt: 2000, data: { five_hour: { utilization: 55 } } },
    }));
    expect(window).toEqual({ key: 'fiveHour', percent: 55, resetAt: null, status: null, source: 'probe', fetchedAt: 2000 });
  });

  it('surfaces the Sonnet window, which only the probe reports', () => {
    const windows = quotaWindows(credential({
      usageProbeSnapshot: { fetchedAt: 2000, data: { seven_day_sonnet: { utilization: 12, resets_at: null } } },
    }));
    expect(windows.map(row => row.key)).toEqual(['sevenDaySonnet']);
  });

  it('omits the Sonnet window when a probe answers without one', () => {
    const windows = quotaWindows(credential({
      usageProbeSnapshot: { fetchedAt: 2000, data: { five_hour: { utilization: 3 } } },
    }));
    expect(windows.map(row => row.key)).toEqual(['fiveHour']);
  });

  it('drops a window neither source reports a utilization for', () => {
    expect(quotaWindows(credential({
      quotaSnapshot: { fetchedAt: 1000, data: quotaData({ fiveHour: { status: 'allowed', reset: null, utilization: null } }) },
    }))).toEqual([]);
    expect(quotaWindows(null)).toEqual([]);
  });
});

describe('probe snapshot', () => {
  it('keeps unrecognized upstream fields instead of dropping them', () => {
    const probe = readProbeSnapshot(credential({
      usageProbeSnapshot: { fetchedAt: 2000, data: { five_hour: { utilization: 1 }, priorIsUsingOverage: false, someNewField: { a: 1 } } },
    }));
    expect(rawEntries(probe?.extras)).toEqual([['priorIsUsingOverage', 'false'], ['someNewField', '{"a":1}']]);
  });

  it('returns null when the upstream body is not an object', () => {
    expect(readProbeSnapshot(credential({ usageProbeSnapshot: { fetchedAt: 2000, data: 'nope' } }))).toBeNull();
  });
});

describe('account status', () => {
  it('treats a rejected plan window as exhausted', () => {
    const lookup = findCredential(record({ accounts: [credential({ quotaSnapshot: { fetchedAt: 1, data: quotaData({ status: 'rejected' }) } })] }));
    expect(accountStatus(lookup, [])).toMatchObject({ tone: 'danger', reason: 'exhausted' });
  });

  it('warns once any window crosses the heavy-usage threshold', () => {
    const lookup = findCredential(record({ accounts: [credential()] }));
    const windows = quotaWindows(credential({ usageProbeSnapshot: { fetchedAt: 1, data: { five_hour: { utilization: 12 }, seven_day: { utilization: 81 } } } }));
    expect(accountStatus(lookup, windows)).toEqual({ tone: 'warning', reason: 'heavy', percent: 81 });
  });

  it('reports a terminated session ahead of any usage reading', () => {
    const lookup = findCredential(record({ accounts: [credential({ state: 'session_terminated', stateMessage: 'revoked' })] }));
    expect(accountStatus(lookup, [{ key: 'fiveHour', percent: 99, resetAt: null, status: null, source: 'probe', fetchedAt: 1 }]))
      .toEqual({ tone: 'danger', reason: 'session-terminated', detail: 'revoked' });
  });

  it('stays active when nothing is wrong', () => {
    const lookup = findCredential(record({ accounts: [credential()] }));
    expect(accountStatus(lookup, [])).toEqual({ tone: 'success', reason: 'active' });
  });
});

describe('overage disabled reason', () => {
  it('hides the steady state every credit-less plan account reports', () => {
    expect(actionableDisabledReason(credential({
      quotaSnapshot: { fetchedAt: 1, data: quotaData({ overage: { status: 'rejected', reset: null, utilization: null, disabledReason: 'out_of_credits' } }) },
    }))).toBeNull();
  });

  it('surfaces any other reason verbatim', () => {
    expect(actionableDisabledReason(credential({
      quotaSnapshot: { fetchedAt: 1, data: quotaData({ overage: { status: 'rejected', reset: null, utilization: null, disabledReason: 'billing_hold' } }) },
    }))).toBe('billing_hold');
  });
});
