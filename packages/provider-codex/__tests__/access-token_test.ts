import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createUpstreamStateRepoStub, type UpstreamStateRepoStub } from './upstream-state-repo.ts';
import {
  ensureCodexAccessToken,
  invalidateCodexAccessToken,
  putCodexAccessToken,
  type CodexAccessTokenEntry,
} from '../src/access-token.ts';
import { CodexOAuthSessionTerminatedError } from '../src/auth/oauth.ts';
import type { CodexUpstreamState } from '../src/state.ts';
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
  modelsCache: null,
  hue: 210,
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
let repo: UpstreamStateRepoStub;

beforeEach(() => {
  current = makeRecord({ accounts: [{ ...baseAccount }] });
  // Write-through, so a subsequent read observes what the last write landed.
  repo = createUpstreamStateRepoStub(() => current, state => {
    current = { ...current!, state: state as CodexUpstreamState };
  });
  initProviderRepo(() => ({ upstreams: repo }));
});

afterEach(() => vi.restoreAllMocks());

const storedState = (): CodexUpstreamState => current!.state as CodexUpstreamState;

describe('putCodexAccessToken', () => {
  test('persists the entry into the account slot, leaving the rest of the credential alone', async () => {
    const entry: CodexAccessTokenEntry = { token: 'at_new', expiresAt: farFutureMs, refreshedAt: '2026-06-01T00:00:00.000Z' };
    await putCodexAccessToken(upstreamId, accountId, entry);
    expect(repo.saveState).toHaveBeenCalledTimes(1);
    expect(repo.saveState.mock.calls[0][0]).toBe(upstreamId);
    expect(storedState()).toEqual({ accounts: [{ ...baseAccount, accessToken: entry }] });
  });

  test('propagates storage failures so the request path surfaces them', async () => {
    repo.saveState.mockRejectedValueOnce(new Error('D1 boom'));
    const entry: CodexAccessTokenEntry = { token: 'at_new', expiresAt: farFutureMs, refreshedAt: 'now' };
    await expect(putCodexAccessToken(upstreamId, accountId, entry)).rejects.toThrow('D1 boom');
  });

  // A minted access token is bookkeeping the next request re-derives, so an
  // operator deleting the upstream mid-request is tolerated. The storage
  // failure above is not — that distinction is the whole point of the typed
  // error.
  test('tolerates an upstream that disappeared mid-flight', async () => {
    current = null;
    const entry: CodexAccessTokenEntry = { token: 'at_new', expiresAt: farFutureMs, refreshedAt: 'now' };
    await putCodexAccessToken(upstreamId, accountId, entry);
    expect(repo.writes).toEqual([]);
  });

  test('warns and writes nothing when the requested account is not in the pool', async () => {
    const entry: CodexAccessTokenEntry = { token: 'at_new', expiresAt: farFutureMs, refreshedAt: 'now' };
    await putCodexAccessToken(upstreamId, 'acc_other', entry);
    expect(repo.writes).toEqual([]);
  });
});

describe('invalidateCodexAccessToken', () => {
  test('clears a populated access-token slot', async () => {
    const entry: CodexAccessTokenEntry = { token: 'at_x', expiresAt: farFutureMs, refreshedAt: 'now' };
    current = makeRecord({ accounts: [{ ...baseAccount, accessToken: entry }] });
    await invalidateCodexAccessToken(upstreamId, accountId);
    expect(storedState().accounts[0].accessToken).toBeNull();
  });

  test('writes nothing when the slot is already null', async () => {
    await invalidateCodexAccessToken(upstreamId, accountId);
    expect(repo.writes).toEqual([]);
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
    expect(storedState().accounts[0].accessToken).toEqual(minted);
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
    expect(repo.writes).toEqual([]);
  });

  test('invalid_grant with a sibling rotation in flight → returns the sibling-minted access token, no persist', async () => {
    // Simulate the race: between our pre-mint read and the upstream rejecting
    // our refresh_token, a sibling worker won the rotation and wrote rt_v2 +
    // at_sibling. Re-read on recovery observes the new pair scoped to the same
    // accountId; we should return it instead of destroying a working
    // credential.
    const siblingEntry: CodexAccessTokenEntry = { token: 'at_sibling', expiresAt: farFutureMs, refreshedAt: 'sibling' };
    repo.getById.mockImplementationOnce(async () => current).mockImplementationOnce(async () => {
      current = makeRecord({ accounts: [{ ...baseAccount, refresh_token: 'rt_v2', accessToken: siblingEntry }] });
      return current;
    });
    const mint = vi.fn().mockRejectedValue(new CodexOAuthSessionTerminatedError({ code: 'invalid_grant', message: 'replayed' }));

    const out = await ensureCodexAccessToken(upstreamId, accountId, mint);
    expect(out).toEqual(siblingEntry);
    expect(mint).toHaveBeenCalledTimes(1);
    // Recovery returns the sibling's cached token; no fresh persist from us.
    expect(repo.writes).toEqual([]);
  });

  test('invalid_grant with stored RT unchanged → rethrows for the caller to flip to terminal', async () => {
    // Same RT on re-read means no sibling rotated; the refresh_token really
    // is dead. The cache surfaces the original error; the data-plane / control-
    // plane caller is responsible for the terminal-state flip.
    const mint = vi.fn().mockRejectedValue(new CodexOAuthSessionTerminatedError({ code: 'invalid_grant', message: 'revoked' }));
    await expect(ensureCodexAccessToken(upstreamId, accountId, mint)).rejects.toBeInstanceOf(CodexOAuthSessionTerminatedError);
    expect(mint).toHaveBeenCalledTimes(1);
    expect(repo.writes).toEqual([]);
  });

  test('app_session_terminated never attempts race recovery — single getById, original error rethrown', async () => {
    // Terminal codes other than invalid_grant signal credential death under
    // any race scenario; the cache must not re-read state to second-guess
    // them. Assert via the absence of a second getById call.
    const mint = vi.fn().mockRejectedValue(new CodexOAuthSessionTerminatedError({ code: 'app_session_terminated', message: 'gone' }));
    await expect(ensureCodexAccessToken(upstreamId, accountId, mint)).rejects.toBeInstanceOf(CodexOAuthSessionTerminatedError);
    expect(repo.getById).toHaveBeenCalledTimes(1);
    expect(repo.writes).toEqual([]);
  });
});
