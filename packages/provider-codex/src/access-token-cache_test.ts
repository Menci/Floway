import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  ensureCodexAccessToken,
  getCodexAccessToken,
  invalidateCodexAccessToken,
  putCodexAccessToken,
  type CodexAccessTokenEntry,
} from './access-token-cache.ts';
import { CodexOAuthSessionTerminatedError } from './auth/oauth.ts';
import type { CodexUpstreamState } from './state.ts';
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
});

const baseAccount = {
  chatgptAccountId: accountId,
  refresh_token: 'rt_v1',
  state: 'active' as const,
  state_updated_at: '2026-06-01T00:00:00.000Z',
  openaiDeviceId: '11111111-2222-4333-8444-555555555555',
  accessToken: null as CodexAccessTokenEntry | null,
  quotaSnapshot: null,
};

const farFutureMs = Date.now() + 24 * 60 * 60 * 1000;

let current: UpstreamRecord | null;
let saveStateSpy: ReturnType<typeof vi.fn<(id: string, newState: unknown, opts: { expectedState: unknown }) => Promise<{ updated: boolean }>>>;
let getByIdSpy: ReturnType<typeof vi.fn<(id: string) => Promise<UpstreamRecord | null>>>;

beforeEach(() => {
  current = makeRecord({ accounts: [{ ...baseAccount }] });
  // Mirror the live D1-backed CAS: write-through so subsequent getById sees the update.
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

describe('getCodexAccessToken', () => {
  test('returns null when the upstream row is missing', async () => {
    current = null;
    expect(await getCodexAccessToken(upstreamId, accountId)).toBeNull();
  });

  test('returns null when the account has no cached access token', async () => {
    expect(await getCodexAccessToken(upstreamId, accountId)).toBeNull();
  });

  test('returns null when the cached token is within the refresh skew window', async () => {
    const expiresSoon = Date.now() + 60 * 1000;
    current = makeRecord({ accounts: [{ ...baseAccount, accessToken: { token: 'at_old', expiresAt: expiresSoon, refreshedAt: '2026-06-01T00:00:00.000Z' } }] });
    expect(await getCodexAccessToken(upstreamId, accountId)).toBeNull();
  });

  test('returns the cached token when still fresh', async () => {
    const entry: CodexAccessTokenEntry = { token: 'at_x', expiresAt: farFutureMs, refreshedAt: '2026-06-01T00:00:00.000Z' };
    current = makeRecord({ accounts: [{ ...baseAccount, accessToken: entry }] });
    expect(await getCodexAccessToken(upstreamId, accountId)).toEqual(entry);
  });

  test('returns null when the requested account is not in the pool', async () => {
    expect(await getCodexAccessToken(upstreamId, 'acc_other')).toBeNull();
  });
});

describe('putCodexAccessToken', () => {
  test('persists the entry into the account slot via saveState', async () => {
    const entry: CodexAccessTokenEntry = { token: 'at_new', expiresAt: farFutureMs, refreshedAt: '2026-06-01T00:00:00.000Z' };
    await putCodexAccessToken(upstreamId, accountId, entry);
    expect(saveStateSpy).toHaveBeenCalledTimes(1);
    const [id, nextState, opts] = saveStateSpy.mock.calls[0];
    expect(id).toBe(upstreamId);
    expect((nextState as CodexUpstreamState).accounts[0].accessToken).toEqual(entry);
    expect(opts.expectedState).toEqual({ accounts: [{ ...baseAccount }] });
  });

  test('propagates saveState failures so the request path surfaces them', async () => {
    saveStateSpy.mockRejectedValueOnce(new Error('CAS lost'));
    const entry: CodexAccessTokenEntry = { token: 'at_new', expiresAt: farFutureMs, refreshedAt: 'now' };
    await expect(putCodexAccessToken(upstreamId, accountId, entry)).rejects.toThrow('CAS lost');
  });

  test('warns and exits when the upstream disappeared mid-flight', async () => {
    current = null;
    const entry: CodexAccessTokenEntry = { token: 'at_new', expiresAt: farFutureMs, refreshedAt: 'now' };
    await putCodexAccessToken(upstreamId, accountId, entry);
    expect(saveStateSpy).not.toHaveBeenCalled();
  });

  test('warns and exits when the requested account is not in the pool', async () => {
    const entry: CodexAccessTokenEntry = { token: 'at_new', expiresAt: farFutureMs, refreshedAt: 'now' };
    await putCodexAccessToken(upstreamId, 'acc_other', entry);
    expect(saveStateSpy).not.toHaveBeenCalled();
  });
});

describe('invalidateCodexAccessToken', () => {
  test('clears a populated access-token slot', async () => {
    const entry: CodexAccessTokenEntry = { token: 'at_x', expiresAt: farFutureMs, refreshedAt: 'now' };
    current = makeRecord({ accounts: [{ ...baseAccount, accessToken: entry }] });
    await invalidateCodexAccessToken(upstreamId, accountId);
    expect(saveStateSpy).toHaveBeenCalledTimes(1);
    expect((saveStateSpy.mock.calls[0][1] as CodexUpstreamState).accounts[0].accessToken).toBeNull();
  });

  test('no-ops when the slot is already null', async () => {
    await invalidateCodexAccessToken(upstreamId, accountId);
    expect(saveStateSpy).not.toHaveBeenCalled();
  });
});

describe('ensureCodexAccessToken', () => {
  test('returns the cached token when still fresh and skips mint', async () => {
    const entry: CodexAccessTokenEntry = { token: 'at_x', expiresAt: farFutureMs, refreshedAt: 'now' };
    current = makeRecord({ accounts: [{ ...baseAccount, accessToken: entry }] });
    const mint = vi.fn();
    const out = await ensureCodexAccessToken(upstreamId, accountId, mint);
    expect(out).toEqual(entry);
    expect(mint).not.toHaveBeenCalled();
  });

  test('mints when nothing is cached, then persists', async () => {
    const minted: CodexAccessTokenEntry = { token: 'at_minted', expiresAt: farFutureMs, refreshedAt: 'now' };
    const mint = vi.fn().mockResolvedValue(minted);
    const out = await ensureCodexAccessToken(upstreamId, accountId, mint);
    expect(out).toEqual(minted);
    expect(mint).toHaveBeenCalledWith('rt_v1');
    expect(saveStateSpy).toHaveBeenCalledTimes(1);
    expect((saveStateSpy.mock.calls[0][1] as CodexUpstreamState).accounts[0].accessToken).toEqual(minted);
  });

  test('mints when the cached token is within the refresh skew window', async () => {
    const expiresSoon = Date.now() + 60 * 1000;
    current = makeRecord({ accounts: [{ ...baseAccount, accessToken: { token: 'at_old', expiresAt: expiresSoon, refreshedAt: 'old' } }] });
    const minted: CodexAccessTokenEntry = { token: 'at_minted', expiresAt: farFutureMs, refreshedAt: 'now' };
    const mint = vi.fn().mockResolvedValue(minted);
    const out = await ensureCodexAccessToken(upstreamId, accountId, mint);
    expect(out).toEqual(minted);
    expect(mint).toHaveBeenCalledWith('rt_v1');
  });

  test('throws when the upstream row is missing', async () => {
    current = null;
    const mint = vi.fn();
    await expect(ensureCodexAccessToken(upstreamId, accountId, mint)).rejects.toThrow(/not found/);
    expect(mint).not.toHaveBeenCalled();
  });

  test('throws when the requested account is not in the pool', async () => {
    const mint = vi.fn();
    await expect(ensureCodexAccessToken(upstreamId, 'acc_other', mint)).rejects.toThrow(/acc_other/);
    expect(mint).not.toHaveBeenCalled();
  });

  test('propagates mint errors without persisting', async () => {
    const mint = vi.fn().mockRejectedValue(new Error('oauth boom'));
    await expect(ensureCodexAccessToken(upstreamId, accountId, mint)).rejects.toThrow(/oauth boom/);
    expect(saveStateSpy).not.toHaveBeenCalled();
  });

  test('invalid_grant with a sibling rotation in flight → returns the sibling-minted access token, no persist', async () => {
    // Simulate the race: between our pre-mint getById and the upstream
    // rejecting our refresh_token, a sibling worker won the rotation and
    // CAS-wrote rt_v2 + at_sibling. Re-read on recovery observes the new
    // pair scoped to the same accountId; we should return it instead of
    // destroying a working credential.
    const siblingEntry: CodexAccessTokenEntry = { token: 'at_sibling', expiresAt: farFutureMs, refreshedAt: 'sibling' };
    getByIdSpy.mockImplementationOnce(async () => current).mockImplementationOnce(async () => {
      current = makeRecord({ accounts: [{ ...baseAccount, refresh_token: 'rt_v2', accessToken: siblingEntry }] });
      return current;
    });
    const mint = vi.fn().mockRejectedValue(new CodexOAuthSessionTerminatedError({ code: 'invalid_grant', message: 'replayed' }));

    const out = await ensureCodexAccessToken(upstreamId, accountId, mint);
    expect(out).toEqual(siblingEntry);
    expect(mint).toHaveBeenCalledTimes(1);
    // Recovery returns the sibling's cached token; no fresh persist from us.
    expect(saveStateSpy).not.toHaveBeenCalled();
  });

  test('invalid_grant with stored RT unchanged → rethrows for the caller to flip to terminal', async () => {
    // Same RT on re-read means no sibling rotated; the refresh_token really
    // is dead. The cache surfaces the original error; the data-plane / control-
    // plane caller is responsible for the terminal-state flip.
    const mint = vi.fn().mockRejectedValue(new CodexOAuthSessionTerminatedError({ code: 'invalid_grant', message: 'revoked' }));
    await expect(ensureCodexAccessToken(upstreamId, accountId, mint)).rejects.toBeInstanceOf(CodexOAuthSessionTerminatedError);
    expect(mint).toHaveBeenCalledTimes(1);
    expect(saveStateSpy).not.toHaveBeenCalled();
  });

  test('app_session_terminated never attempts race recovery — single getById, original error rethrown', async () => {
    // Terminal codes other than invalid_grant signal credential death under
    // any race scenario; the cache must not re-read state to second-guess
    // them. Assert via the absence of a second getById call.
    const mint = vi.fn().mockRejectedValue(new CodexOAuthSessionTerminatedError({ code: 'app_session_terminated', message: 'gone' }));
    await expect(ensureCodexAccessToken(upstreamId, accountId, mint)).rejects.toBeInstanceOf(CodexOAuthSessionTerminatedError);
    expect(getByIdSpy).toHaveBeenCalledTimes(1);
    expect(saveStateSpy).not.toHaveBeenCalled();
  });
});
