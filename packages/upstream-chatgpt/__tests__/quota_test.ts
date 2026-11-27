import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createUpstreamStateRepoStub, type UpstreamStateRepoStub } from './upstream-state-repo.ts';
import {
  getChatGPTQuota,
  parseChatGPTQuotaHeaders,
  putChatGPTQuota,
} from '../src/quota.ts';
import type { ChatGPTQuotaSnapshot, ChatGPTQuotaSnapshotEntryMap, ChatGPTUpstreamState } from '../src/state.ts';
import { initUpstreamRuntimeRepo, type UpstreamRecord } from '@floway-dev/upstream';

const accountId = 'acc_1';
const upstreamId = 'up_a';

const makeRecord = (state: ChatGPTUpstreamState): UpstreamRecord => ({
  id: upstreamId,
  kind: 'chatgpt',
  name: 'ChatGPT',
  enabled: true,
  usageRefreshIntervalMinutes: 0,
  sortOrder: 0,
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
  config: { accounts: [{ email: 'a@b.com', chatgptAccountId: accountId, chatgptUserId: 'usr', planType: 'plus' }] },
  state,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  hue: 210,
});

const baseAccount = {
  chatgptAccountId: accountId,
  refresh_token: 'rt_v1',
  state: 'active' as const,
  state_updated_at: '2026-06-01T00:00:00.000Z',
  openaiDeviceId: '11111111-2222-4333-8444-555555555555',
  accessToken: null,
  quotaSnapshot: null as ChatGPTQuotaSnapshotEntryMap | null,
};

let current: UpstreamRecord | null;
let repo: UpstreamStateRepoStub;

beforeEach(() => {
  current = makeRecord({ accounts: [{ ...baseAccount }] });
  repo = createUpstreamStateRepoStub(() => current, state => {
    current = { ...current!, state: state as ChatGPTUpstreamState };
  });
  initUpstreamRuntimeRepo(() => ({ recordUpstreamMetric: async () => {}, upstreams: repo }));
});

afterEach(() => vi.restoreAllMocks());

describe('parseChatGPTQuotaHeaders', () => {
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
    const snapshot = parseChatGPTQuotaHeaders(headers, { now: observedAt, isRateLimited: false });
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

  // Upstream added `-reset-at` on 2025-10-17 and kept sending the offset it
  // replaced, so the absolute instant wins and the offset is the fallback.
  test('prefers the absolute reset instant over the offset it replaced', () => {
    const headers = new Headers({
      'x-codex-primary-reset-at': '1780272000',
      'x-codex-primary-reset-after-seconds': '18000',
      'x-codex-secondary-reset-after-seconds': '7200',
    });
    const snapshot = parseChatGPTQuotaHeaders(headers, { now: new Date('2026-06-05T00:00:00.000Z'), isRateLimited: false });
    expect(snapshot.primary_reset_after_at).toBe(new Date(1780272000 * 1000).toISOString());
    // No absolute instant for the secondary, so the offset still dates it.
    expect(snapshot.secondary_reset_after_at).toBe('2026-06-05T02:00:00.000Z');
  });

  // A plan whose secondary window is zero minutes wide reports a blank instant
  // beside a zero offset. That is "no such window", not "it resets now".
  test('reports no reset for a window this plan does not have', () => {
    const headers = new Headers({
      'x-codex-secondary-window-minutes': '0',
      'x-codex-secondary-reset-at': '',
      'x-codex-secondary-reset-after-seconds': '0',
    });
    const snapshot = parseChatGPTQuotaHeaders(headers, { now: new Date('2026-06-05T00:00:00.000Z'), isRateLimited: false });
    expect(snapshot.secondary_reset_after_at).toBeUndefined();
  });

  test.each([
    ['primary only', '100', '35', '2026-06-05T01:00:00.000Z'],
    ['neither', '99.9', '35', undefined],
  ])('uses only known exhausted windows: %s', (_name, primary, secondary, expected) => {
    const headers = new Headers({
      'x-codex-primary-reset-after-seconds': '3600',
      'x-codex-secondary-reset-after-seconds': '7200',
    });
    if (primary !== undefined) headers.set('x-codex-primary-used-percent', primary);
    if (secondary !== undefined) headers.set('x-codex-secondary-used-percent', secondary);
    const snapshot = parseChatGPTQuotaHeaders(headers, { now: new Date('2026-06-05T00:00:00.000Z'), isRateLimited: true });
    expect(snapshot.ratelimited_until).toBe(expected);
  });

  test.each([
    ['RFC 3339', '2026-06-05T03:00:00+02:00', '9999'],
    ['offset', '', '3600'],
  ])('uses the supported %s exhausted reset format', (_name, at, after) => {
    const snapshot = parseChatGPTQuotaHeaders(new Headers({
      'x-codex-primary-used-percent': '100',
      'x-codex-primary-reset-at': at,
      'x-codex-primary-reset-after-seconds': after,
    }), { now: new Date('2026-06-05T00:00:00.000Z'), isRateLimited: true });
    expect(snapshot.ratelimited_until).toBe('2026-06-05T01:00:00.000Z');
  });
});

describe('getChatGPTQuota', () => {
  test('projects legacy expiry per family without changing stored observations or successful snapshots', async () => {
    const primary: ChatGPTQuotaSnapshot = {
      observed_at: '2026-06-05T00:00:00.000Z',
      primary_used_percent: 100,
      primary_reset_after_at: '2026-06-05T01:00:00.000Z',
      secondary_used_percent: 35,
      secondary_reset_after_at: '2026-06-09T00:00:00.000Z',
      ratelimited_until: '2026-06-09T00:00:00.000Z',
    };
    const secondary: ChatGPTQuotaSnapshot = { ...primary, primary_used_percent: 35, secondary_used_percent: 100 };
    const { primary_used_percent: _primaryUsed, secondary_used_percent: _secondaryUsed, ...unknown } = primary;
    const { secondary_reset_after_at: _secondaryReset, ...partialBase } = secondary;
    const partial: ChatGPTQuotaSnapshot = { ...partialBase, primary_used_percent: 100 };
    const neither: ChatGPTQuotaSnapshot = { ...primary, primary_used_percent: 35 };
    const { primary_reset_after_at: _primaryReset, ...untimed } = primary;
    const invalid: ChatGPTQuotaSnapshot = { ...primary, primary_reset_after_at: 'invalid' };
    const { ratelimited_until: _until, ...successful } = primary;
    current = makeRecord({
      accounts: [{
        ...baseAccount,
        quotaSnapshot: Object.fromEntries(
          Object.entries({ primary, secondary, unknown, partial, neither, untimed, invalid, successful }).map(([key, data]) => [key, { fetchedAt: 1, data }]),
        ),
      }],
    });
    const stored = structuredClone(current);
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-06-06T00:00:00.000Z'));
    const { ratelimited_until: _unknownUntil, ...unknownReading } = unknown;
    const { ratelimited_until: _neitherUntil, ...neitherReading } = neither;
    const { ratelimited_until: _untimedUntil, ...untimedReading } = untimed;
    const { ratelimited_until: _invalidUntil, ...invalidReading } = invalid;
    expect(await getChatGPTQuota(upstreamId, accountId)).toEqual({
      primary: { ...primary, ratelimited_until: primary.primary_reset_after_at },
      secondary,
      unknown: unknownReading,
      partial: { ...partial, ratelimited_until: primary.primary_reset_after_at },
      neither: neitherReading,
      untimed: untimedReading,
      invalid: invalidReading,
      successful,
    });
    expect(current).toEqual(stored);
    expect(repo.writes).toEqual([]);
  });

});

describe('putChatGPTQuota', () => {
  test('preserves other active-limit buckets and replaces the matching bucket', async () => {
    const premium: ChatGPTQuotaSnapshot = { observed_at: '2026-06-05T00:00:00.000Z', active_limit: 'premium', primary_used_percent: 10 };
    current = makeRecord({ accounts: [{ ...baseAccount, quotaSnapshot: { premium: { fetchedAt: 1, data: premium } } }] });
    const bengalfox: ChatGPTQuotaSnapshot = { observed_at: '2026-06-05T01:00:00.000Z', active_limit: 'codex_bengalfox', primary_used_percent: 20 };
    await putChatGPTQuota(upstreamId, accountId, bengalfox);
    let written = (current!.state as ChatGPTUpstreamState).accounts[0].quotaSnapshot;
    expect(written?.premium.data).toEqual(premium);
    expect(written?.codex_bengalfox.data).toEqual(bengalfox);

    const nextPremium: ChatGPTQuotaSnapshot = { observed_at: '2026-06-05T02:00:00.000Z', active_limit: 'premium', primary_used_percent: 30 };
    await putChatGPTQuota(upstreamId, accountId, nextPremium);
    written = (current!.state as ChatGPTUpstreamState).accounts[0].quotaSnapshot;
    expect(Object.keys(written ?? {}).sort()).toEqual(['codex_bengalfox', 'premium']);
    expect(written?.premium.data).toEqual(nextPremium);
    expect(written?.codex_bengalfox.data).toEqual(bengalfox);
  });
});

test('publishes self-contained usage observations with capture timestamps and retries failed delivery', async () => {
  const failure = new Error('Usage storage unavailable');
  const recordUpstreamMetric = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined);
  initUpstreamRuntimeRepo(() => ({ upstreams: repo, recordUpstreamMetric }));
  const snapshot = { observed_at: '2026-06-05T00:00:00.000Z', active_limit: 'codex', primary_used_percent: 42, primary_window_minutes: 300 };
  await expect(putChatGPTQuota(upstreamId, accountId, snapshot)).rejects.toBe(failure);
  await putChatGPTQuota(upstreamId, accountId, snapshot);
  expect(recordUpstreamMetric).toHaveBeenCalledTimes(2);
  expect(recordUpstreamMetric).toHaveBeenLastCalledWith(upstreamId, 'quota.window.used_percent', { limit: 'codex', window_seconds: 18_000 }, 42, Date.parse(snapshot.observed_at));
});
