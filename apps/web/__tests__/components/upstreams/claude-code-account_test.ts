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
} from '../../../src/components/upstreams/claude-code-account';

type ClaudeCodeRecord = Extract<UpstreamRecord, { kind: 'claude-code' }>;

const ACCOUNT_UUID = '11111111-2222-3333-4444-555555555555';
const NOW = Date.parse('2026-07-28T12:00:00.000Z');

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

describe('credential lookup', () => {
  it('reports a mismatch rather than falling back to whatever account is stored', () => {
    const lookup = findCredential(record({ accounts: [credential({ accountUuid: 'someone-else' })] }));
    expect(lookup).toEqual({ kind: 'uuid-mismatch', expectedAccountUuid: ACCOUNT_UUID });
  });
});

describe('quota windows', () => {
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
});

describe('account status', () => {
  const rejectedAt = (reset: string | null) => findCredential(record({
    accounts: [credential({ quotaSnapshot: { fetchedAt: 1, data: quotaData({ status: 'rejected', reset, representativeClaim: 'seven_day' }) } })],
  }));

  it('treats a rejected plan window as exhausted while its limit is still running', () => {
    expect(accountStatus(rejectedAt('2026-07-28T15:00:00.000Z'), [], NOW)).toMatchObject({ tone: 'danger', reason: 'exhausted' });
  });
});

describe('overage disabled reason', () => {
  it('hides the steady state every credit-less plan account reports', () => {
    expect(actionableDisabledReason(credential({
      quotaSnapshot: { fetchedAt: 1, data: quotaData({ overage: { status: 'rejected', reset: null, utilization: null, disabledReason: 'out_of_credits' } }) },
    }))).toBeNull();
  });
});
