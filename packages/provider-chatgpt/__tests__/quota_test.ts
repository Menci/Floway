import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createUpstreamStateRepoStub, type UpstreamStateRepoStub } from './upstream-state-repo.ts';
import {
  CHATGPT_QUOTA_UNKNOWN_ACTIVE_LIMIT,
  chatgptQuotaActiveLimitKey,
  clearChatGPTQuota,
  getChatGPTQuota,
  parseChatGPTQuotaHeaders,
  putChatGPTQuota,
} from '../src/quota.ts';
import type { ChatGPTQuotaSnapshot, ChatGPTQuotaSnapshotEntryMap, ChatGPTUpstreamState } from '../src/state.ts';
import { initProviderRepo, type UpstreamRecord } from '@floway-dev/provider';

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
  modelsCache: null,
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
  initProviderRepo(() => ({ recordUpstreamMetric: async () => {}, upstreams: repo }));
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

  // `Number('')` is 0, so a blank reading would otherwise land as a confident
  // zero balance rather than as nothing observed.
  test('reads a blank numeric header as absent rather than as zero', () => {
    const headers = new Headers({ 'x-codex-credits-balance': '', 'x-codex-secondary-used-percent': '  ' });
    const snapshot = parseChatGPTQuotaHeaders(headers, { now: new Date('2026-06-05T00:00:00.000Z'), isRateLimited: false });
    expect(snapshot.credits_balance).toBeUndefined();
    expect(snapshot.secondary_used_percent).toBeUndefined();
  });

  test.each([
    ['primary only', '100', '35', '2026-06-05T01:00:00.000Z'],
    ['secondary only', '35', '100', '2026-06-05T02:00:00.000Z'],
    ['neither', '99.9', '35', undefined],
    ['invalid usage', 'NaN', 'Infinity', undefined],
    ['unknown primary', undefined, '100', '2026-06-05T02:00:00.000Z'],
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

  test.each([undefined, 'invalid'])('does not guess an expiry without a usable exhausted reset: %s', reset => {
    const headers = new Headers({ 'x-codex-primary-used-percent': '100' });
    if (reset !== undefined) {
      headers.set('x-codex-primary-reset-at', reset);
      headers.set('x-codex-primary-reset-after-seconds', reset);
    }
    const snapshot = parseChatGPTQuotaHeaders(headers, { now: new Date('2026-06-05T00:00:00.000Z'), isRateLimited: true });
    expect(snapshot.ratelimited_until).toBeUndefined();
    expect(snapshot.primary_used_percent).toBe(100);
  });

  test.each([
    ['epoch', '1780621200', '9999'],
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

describe('chatgptQuotaActiveLimitKey', () => {

  test('falls back to unknown when the active_limit is missing or blank', () => {
    expect(chatgptQuotaActiveLimitKey({ observed_at: 'now' })).toBe(CHATGPT_QUOTA_UNKNOWN_ACTIVE_LIMIT);
    expect(chatgptQuotaActiveLimitKey({ observed_at: 'now', active_limit: '   ' })).toBe(CHATGPT_QUOTA_UNKNOWN_ACTIVE_LIMIT);
    expect(chatgptQuotaActiveLimitKey({ observed_at: 'now', active_limit: 'constructor' })).toBe(CHATGPT_QUOTA_UNKNOWN_ACTIVE_LIMIT);
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
    const unknown: ChatGPTQuotaSnapshot = { ...primary, primary_used_percent: undefined, secondary_used_percent: undefined };
    const partial: ChatGPTQuotaSnapshot = { ...secondary, primary_used_percent: 100, secondary_reset_after_at: undefined };
    const neither: ChatGPTQuotaSnapshot = { ...primary, primary_used_percent: 35 };
    const untimed: ChatGPTQuotaSnapshot = { ...primary, primary_reset_after_at: undefined };
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

  // An old reading rendered with the instant it was taken tells an operator
  // more than an empty card, so age withholds nothing -- the dashboard is the
  // only reader, and traffic on the upstream replaces what it shows.
  test('returns every bucket however long ago it was observed', async () => {
    const recent: ChatGPTQuotaSnapshot = { observed_at: '2026-06-05T00:00:00.000Z', active_limit: 'recent' };
    const ancient: ChatGPTQuotaSnapshot = { observed_at: '2026-06-01T00:00:00.000Z', active_limit: 'ancient' };
    current = makeRecord({
      accounts: [{
        ...baseAccount,
        quotaSnapshot: {
          recent: { fetchedAt: Date.now(), data: recent },
          ancient: { fetchedAt: Date.now() - 90 * 24 * 60 * 60 * 1000, data: ancient },
        },
      }],
    });
    expect(await getChatGPTQuota(upstreamId, accountId)).toEqual({ recent, ancient });
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

describe('clearChatGPTQuota', () => {
  test('invalidates every observed bucket without touching the credential', async () => {
    const snap: ChatGPTQuotaSnapshot = { observed_at: '2026-06-05T00:00:00.000Z', active_limit: 'premium', primary_used_percent: 90 };
    current = makeRecord({ accounts: [{ ...baseAccount, quotaSnapshot: { premium: { fetchedAt: 1, data: snap } } }] });
    await clearChatGPTQuota(upstreamId, accountId);
    expect((current!.state as ChatGPTUpstreamState).accounts[0]).toEqual({ ...baseAccount, quotaSnapshot: null });
  });
});

test('publishes self-contained usage observations with capture timestamps and retries failed delivery', async () => {
  const failure = new Error('Usage storage unavailable');
  const recordUpstreamMetric = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined);
  initProviderRepo(() => ({ upstreams: repo, recordUpstreamMetric }));
  const snapshot = { observed_at: '2026-06-05T00:00:00.000Z', active_limit: 'codex', primary_used_percent: 42, primary_window_minutes: 300 };
  await expect(putChatGPTQuota(upstreamId, accountId, snapshot)).rejects.toBe(failure);
  await putChatGPTQuota(upstreamId, accountId, snapshot);
  expect(recordUpstreamMetric).toHaveBeenCalledTimes(2);
  expect(recordUpstreamMetric).toHaveBeenLastCalledWith(upstreamId, 'quota.window.used_percent', { limit: 'codex', window_seconds: 18_000 }, 42, Date.parse(snapshot.observed_at));
});
