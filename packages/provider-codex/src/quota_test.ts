import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  CODEX_QUOTA_UNKNOWN_ACTIVE_LIMIT,
  codexQuotaActiveLimitKey,
  computeCodexQuotaTtlMs,
  getCodexQuota,
  parseCodexQuotaHeaders,
  putCodexQuota,
  type CodexQuotaSnapshot,
} from './quota.ts';
import type { CodexQuotaSnapshotMapEntry, CodexUpstreamState } from './state.ts';
import { initProviderRepo, type UpstreamRecord } from '@floway-dev/provider';

const accountId = 'acc_1';
const upstreamId = 'up_a';

const makeRecord = (state: CodexUpstreamState): UpstreamRecord => ({
  id: upstreamId,
  kind: 'codex',
  name: 'Codex',
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
  config: { accounts: [{ email: 'a@b.com', chatgptAccountId: accountId, chatgptUserId: 'usr', planType: 'plus' }] },
  state,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  color: null,
});

const baseAccount = {
  chatgptAccountId: accountId,
  refresh_token: 'rt_v1',
  state: 'active' as const,
  state_updated_at: '2026-06-01T00:00:00.000Z',
  openaiDeviceId: '11111111-2222-4333-8444-555555555555',
  accessToken: null,
  quotaSnapshot: null as CodexQuotaSnapshotMapEntry | null,
};

let current: UpstreamRecord | null;
let saveStateSpy: ReturnType<typeof vi.fn<(id: string, newState: unknown, opts: { expectedState: unknown }) => Promise<{ updated: boolean }>>>;
let getByIdSpy: ReturnType<typeof vi.fn<(id: string) => Promise<UpstreamRecord | null>>>;

beforeEach(() => {
  current = makeRecord({ accounts: [{ ...baseAccount }] });
  saveStateSpy = vi.fn(async (_id, newState, _opts) => {
    if (current) current = { ...current, state: newState as CodexUpstreamState };
    return { updated: true };
  });
  getByIdSpy = vi.fn(async () => current);
  initProviderRepo(() => ({
    upstreams: { getById: getByIdSpy, saveState: saveStateSpy },
  }));
});

afterEach(() => vi.restoreAllMocks());

describe('parseCodexQuotaHeaders', () => {
  test('parses a 200 snapshot (no ratelimited_until)', () => {
    const headers = new Headers({
      'x-codex-active-limit': 'premium',
      'x-codex-plan-type': 'plus',
      'x-codex-primary-used-percent': '42',
      'x-codex-primary-window-minutes': '300',
      'x-codex-primary-reset-after-seconds': '18000',
      'x-codex-secondary-used-percent': '94',
      'x-codex-secondary-window-minutes': '10080',
      'x-codex-secondary-reset-after-seconds': '486400',
      'x-codex-credits-has-credits': 'False',
      'x-codex-credits-balance': '0',
    });
    const observedAt = new Date('2026-06-05T00:00:00.000Z');
    const snapshot = parseCodexQuotaHeaders(headers, { now: observedAt, isRateLimited: false });
    expect(snapshot).toMatchObject({
      observed_at: '2026-06-05T00:00:00.000Z',
      active_limit: 'premium',
      plan_type: 'plus',
      primary_used_percent: 42,
      primary_window_minutes: 300,
      primary_reset_after_at: '2026-06-05T05:00:00.000Z',
      secondary_used_percent: 94,
      secondary_window_minutes: 10080,
      credits_has_credits: false,
      credits_balance: 0,
    });
    expect(snapshot.ratelimited_until).toBeUndefined();
  });

  test('sets ratelimited_until from max(primary, secondary) reset window on 429', () => {
    const headers = new Headers({
      'x-codex-primary-reset-after-seconds': '3600',
      'x-codex-secondary-reset-after-seconds': '7200',
    });
    const observedAt = new Date('2026-06-05T00:00:00.000Z');
    const snapshot = parseCodexQuotaHeaders(headers, { now: observedAt, isRateLimited: true });
    expect(snapshot.ratelimited_until).toBe('2026-06-05T02:00:00.000Z');
  });

  test('normalizes string headers at the provider boundary', () => {
    const observedAt = new Date('2026-06-05T00:00:00.000Z');
    const snapshot = parseCodexQuotaHeaders(new Headers({
      'x-codex-active-limit': '  premium  ',
      'x-codex-plan-type': '   ',
    }), { now: observedAt, isRateLimited: false });
    expect(snapshot).toEqual({ observed_at: '2026-06-05T00:00:00.000Z', active_limit: 'premium' });
  });
});

describe('codexQuotaActiveLimitKey', () => {
  test('uses the active_limit when present', () => {
    expect(codexQuotaActiveLimitKey({ observed_at: 'now', active_limit: 'codex_bengalfox' })).toBe('codex_bengalfox');
  });

  test('falls back to unknown when the active_limit is missing or blank', () => {
    expect(codexQuotaActiveLimitKey({ observed_at: 'now' })).toBe(CODEX_QUOTA_UNKNOWN_ACTIVE_LIMIT);
    expect(codexQuotaActiveLimitKey({ observed_at: 'now', active_limit: '   ' })).toBe(CODEX_QUOTA_UNKNOWN_ACTIVE_LIMIT);
    expect(codexQuotaActiveLimitKey({ observed_at: 'now', active_limit: 'constructor' })).toBe(CODEX_QUOTA_UNKNOWN_ACTIVE_LIMIT);
  });
});

describe('getCodexQuota', () => {
  test('returns null when the upstream row is missing', async () => {
    current = null;
    expect(await getCodexQuota(upstreamId, accountId)).toBeNull();
  });

  test('returns null when the account has no snapshot', async () => {
    expect(await getCodexQuota(upstreamId, accountId)).toBeNull();
  });

  test('returns the quota map when buckets are fresh', async () => {
    const snap: CodexQuotaSnapshot = { observed_at: '2026-06-05T00:00:00.000Z', active_limit: 'premium', primary_used_percent: 10 };
    current = makeRecord({ accounts: [{ ...baseAccount, quotaSnapshot: { premium: { fetchedAt: Date.now(), data: snap } } }] });
    expect(await getCodexQuota(upstreamId, accountId)).toEqual({ premium: snap });
  });

  test('returns null when every bucket is past its TTL window', async () => {
    const snap: CodexQuotaSnapshot = { observed_at: '2026-06-01T00:00:00.000Z' };
    const fetchedAt = Date.now() - 2 * 24 * 60 * 60 * 1000;
    current = makeRecord({ accounts: [{ ...baseAccount, quotaSnapshot: { premium: { fetchedAt, data: snap } } }] });
    expect(await getCodexQuota(upstreamId, accountId)).toBeNull();
  });

  test('filters stale buckets independently', async () => {
    const freshSnap: CodexQuotaSnapshot = { observed_at: '2026-06-05T00:00:00.000Z', active_limit: 'fresh' };
    const staleSnap: CodexQuotaSnapshot = { observed_at: '2026-06-01T00:00:00.000Z', active_limit: 'stale' };
    current = makeRecord({
      accounts: [{
        ...baseAccount,
        quotaSnapshot: {
          fresh: { fetchedAt: Date.now(), data: freshSnap },
          stale: { fetchedAt: Date.now() - 2 * 24 * 60 * 60 * 1000, data: staleSnap },
        },
      }],
    });
    expect(await getCodexQuota(upstreamId, accountId)).toEqual({ fresh: freshSnap });
  });

  test('returns null when the requested account is not in the pool', async () => {
    expect(await getCodexQuota(upstreamId, 'acc_other')).toBeNull();
  });
});

describe('putCodexQuota', () => {
  test('persists the snapshot under its active limit via saveState', async () => {
    const snap: CodexQuotaSnapshot = { observed_at: '2026-06-05T00:00:00.000Z', active_limit: 'premium', primary_used_percent: 42 };
    await putCodexQuota(upstreamId, accountId, snap);
    expect(saveStateSpy).toHaveBeenCalledTimes(1);
    const [id, nextState, opts] = saveStateSpy.mock.calls[0];
    expect(id).toBe(upstreamId);
    const written = (nextState as CodexUpstreamState).accounts[0].quotaSnapshot;
    expect(written?.premium?.data).toEqual(snap);
    expect(typeof written?.premium?.fetchedAt).toBe('number');
    expect(opts.expectedState).toEqual({ accounts: [{ ...baseAccount }] });
  });

  test('preserves other active-limit buckets and replaces the matching bucket', async () => {
    const premium: CodexQuotaSnapshot = { observed_at: '2026-06-05T00:00:00.000Z', active_limit: 'premium', primary_used_percent: 10 };
    current = makeRecord({ accounts: [{ ...baseAccount, quotaSnapshot: { premium: { fetchedAt: 1, data: premium } } }] });
    const bengalfox: CodexQuotaSnapshot = { observed_at: '2026-06-05T01:00:00.000Z', active_limit: 'codex_bengalfox', primary_used_percent: 20 };
    await putCodexQuota(upstreamId, accountId, bengalfox);
    let written = (current!.state as CodexUpstreamState).accounts[0].quotaSnapshot;
    expect(written?.premium.data).toEqual(premium);
    expect(written?.codex_bengalfox.data).toEqual(bengalfox);

    const nextPremium: CodexQuotaSnapshot = { observed_at: '2026-06-05T02:00:00.000Z', active_limit: 'premium', primary_used_percent: 30 };
    await putCodexQuota(upstreamId, accountId, nextPremium);
    written = (current!.state as CodexUpstreamState).accounts[0].quotaSnapshot;
    expect(Object.keys(written ?? {}).sort()).toEqual(['codex_bengalfox', 'premium']);
    expect(written?.premium.data).toEqual(nextPremium);
    expect(written?.codex_bengalfox.data).toEqual(bengalfox);
  });

  test('uses the unknown key when active_limit is absent', async () => {
    const snap: CodexQuotaSnapshot = { observed_at: '2026-06-05T00:00:00.000Z', primary_used_percent: 42 };
    await putCodexQuota(upstreamId, accountId, snap);
    const written = (current!.state as CodexUpstreamState).accounts[0].quotaSnapshot;
    expect(written?.unknown.data).toEqual(snap);
  });

  test('throws when the upstream disappeared mid-flight', async () => {
    current = null;
    await expect(putCodexQuota(upstreamId, accountId, { observed_at: 'now' })).rejects.toThrow(/disappeared mid-request/);
    expect(saveStateSpy).not.toHaveBeenCalled();
  });

  test('throws when the requested account is not in the pool', async () => {
    await expect(putCodexQuota(upstreamId, 'acc_other', { observed_at: 'now' })).rejects.toThrow(/not found in upstream/);
    expect(saveStateSpy).not.toHaveBeenCalled();
  });
});

describe('computeCodexQuotaTtlMs', () => {
  test('floors at 24h when no reset horizons are present', () => {
    const now = new Date('2026-06-05T00:00:00.000Z');
    expect(computeCodexQuotaTtlMs({ observed_at: now.toISOString() }, now)).toBe(24 * 60 * 60 * 1000);
  });

  test('extends past floor to the furthest reset horizon', () => {
    const now = new Date('2026-06-05T00:00:00.000Z');
    const snap: CodexQuotaSnapshot = {
      observed_at: now.toISOString(),
      primary_reset_after_at: '2026-06-08T00:00:00.000Z',
    };
    expect(computeCodexQuotaTtlMs(snap, now)).toBe(3 * 24 * 60 * 60 * 1000);
  });
});
