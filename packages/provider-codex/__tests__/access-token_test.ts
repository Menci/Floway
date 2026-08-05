import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createUpstreamStateRepoStub, type UpstreamStateRepoStub } from './upstream-state-repo.ts';
import {
  ensureCodexAccessToken,
  invalidateCodexAccessToken,
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

describe('invalidateCodexAccessToken', () => {
  test('clears a populated access-token slot', async () => {
    const entry: CodexAccessTokenEntry = { token: 'at_x', expiresAt: farFutureMs, refreshedAt: 'now' };
    current = makeRecord({ accounts: [{ ...baseAccount, accessToken: entry }] });
    await invalidateCodexAccessToken(upstreamId, accountId, 'at_x');
    expect(storedState().accounts[0].accessToken).toBeNull();
  });

  test('writes nothing when the slot is already null', async () => {
    await invalidateCodexAccessToken(upstreamId, accountId, 'at_old');
    expect(repo.writes).toEqual([]);
  });

  test('does not clear a newer token written after the rejected request started', async () => {
    const entry: CodexAccessTokenEntry = { token: 'at_newer', expiresAt: farFutureMs, refreshedAt: 'newer' };
    current = makeRecord({ accounts: [{ ...baseAccount, accessToken: entry }] });
    await invalidateCodexAccessToken(upstreamId, accountId, 'at_rejected');
    expect(repo.writes).toEqual([]);
    expect(storedState().accounts[0].accessToken).toEqual(entry);
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

  test('propagates storage failures after a mint', async () => {
    const minted: CodexAccessTokenEntry = { token: 'at_minted', expiresAt: farFutureMs, refreshedAt: 'now' };
    repo.saveState.mockRejectedValueOnce(new Error('D1 boom'));
    await expect(ensureCodexAccessToken(upstreamId, accountId, vi.fn().mockResolvedValue(minted)))
      .rejects.toThrow('D1 boom');
  });

  test('returns the minted token when the upstream is deleted before cache persistence', async () => {
    const minted: CodexAccessTokenEntry = { token: 'at_minted', expiresAt: farFutureMs, refreshedAt: 'now' };
    const mint = vi.fn(async () => {
      current = null;
      return minted;
    });
    await expect(ensureCodexAccessToken(upstreamId, accountId, mint)).resolves.toEqual(minted);
    expect(repo.writes).toEqual([]);
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

  test('refuses to mint into a terminal credential', async () => {
    current = makeRecord({ accounts: [{
      ...baseAccount,
      state: 'session_terminated',
      state_message: 'old session ended',
    }] });
    const mint = vi.fn();
    await expect(ensureCodexAccessToken(upstreamId, accountId, mint))
      .rejects.toBeInstanceOf(CodexOAuthSessionTerminatedError);
    expect(mint).not.toHaveBeenCalled();
    expect(repo.writes).toEqual([]);
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

  test('parallel cold-start callers share one mint', async () => {
    const minted: CodexAccessTokenEntry = { token: 'at_minted', expiresAt: farFutureMs, refreshedAt: 'now' };
    const mint = vi.fn().mockResolvedValue(minted);
    const results = await Promise.all([
      ensureCodexAccessToken(upstreamId, accountId, mint),
      ensureCodexAccessToken(upstreamId, accountId, mint),
    ]);
    expect(mint).toHaveBeenCalledTimes(1);
    expect(results).toEqual([minted, minted]);
  });

  test('lazy and forced callers never rotate the same refresh token concurrently', async () => {
    let releaseMint!: () => void;
    const mintGate = new Promise<void>(resolve => { releaseMint = resolve; });
    const minted: CodexAccessTokenEntry = { token: 'at_minted', expiresAt: farFutureMs, refreshedAt: 'now' };
    const mint = vi.fn(async () => {
      await mintGate;
      return minted;
    });
    const lazy = ensureCodexAccessToken(upstreamId, accountId, mint);
    const forced = ensureCodexAccessToken(upstreamId, accountId, mint, true);
    await vi.waitFor(() => expect(mint).toHaveBeenCalledTimes(1));
    releaseMint();
    expect(await Promise.all([lazy, forced])).toEqual([minted, minted]);
    expect(mint).toHaveBeenCalledTimes(1);
  });

  test('a force request following a coalesced cache hit performs one rotation', async () => {
    const cached: CodexAccessTokenEntry = { token: 'at_cached', expiresAt: farFutureMs, refreshedAt: 'cached' };
    const minted: CodexAccessTokenEntry = { token: 'at_minted', expiresAt: farFutureMs, refreshedAt: 'minted' };
    current = makeRecord({ accounts: [{ ...baseAccount, accessToken: cached }] });
    const mint = vi.fn().mockResolvedValue(minted);
    const [lazyResult, forcedResult] = await Promise.all([
      ensureCodexAccessToken(upstreamId, accountId, mint),
      ensureCodexAccessToken(upstreamId, accountId, mint, true),
    ]);
    expect(lazyResult).toEqual(cached);
    expect(forcedResult).toEqual(minted);
    expect(mint).toHaveBeenCalledTimes(1);
  });
});
