import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  ensureClaudeCodeAccessToken,
  invalidateClaudeCodeAccessToken,
  type ClaudeCodeAccessTokenEntry,
} from './access-token-cache.ts';
import { ClaudeCodeOAuthSessionTerminatedError } from './auth/oauth.ts';
import type { ClaudeCodeUpstreamConfig } from './config.ts';
import type { ClaudeCodeUpstreamState } from './state.ts';
import { directFetcher, type UpstreamRecord, type UpstreamsRepoSlim } from '@floway-dev/provider';

const accountUuid = 'acc-uuid-1';
const upstreamId = 'up-claude-1';

const baseConfig: ClaudeCodeUpstreamConfig = {
  accounts: [{
    email: 'user@example.com',
    accountUuid,
    organizationUuid: 'org-uuid-1',
    subscriptionType: 'max',
    rateLimitTier: 'default_claude_max_20x',
  }],
};

const makeRecord = (state: ClaudeCodeUpstreamState): UpstreamRecord => ({
  id: upstreamId,
  kind: 'claude-code',
  name: 'Claude Code',
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
  config: baseConfig,
  state,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
});

const baseAccount: ClaudeCodeUpstreamState['accounts'][number] = {
  accountUuid,
  tokenKind: 'oauth',
  refreshToken: 'rt_v1',
  state: 'active',
  stateUpdatedAt: '2026-06-01T00:00:00.000Z',
  accessToken: null,
  quotaSnapshot: null,
  usageProbeSnapshot: null,
};

const farFutureMs = Date.now() + 24 * 60 * 60 * 1000;

type SaveStateSpy = ReturnType<typeof vi.fn<(id: string, newState: unknown, opts: { expectedState: unknown }) => Promise<{ updated: boolean }>>>;
type GetByIdSpy = ReturnType<typeof vi.fn<(id: string) => Promise<UpstreamRecord | null>>>;

let current: UpstreamRecord | null;
let saveStateSpy: SaveStateSpy;
let getByIdSpy: GetByIdSpy;
let repo: UpstreamsRepoSlim;

beforeEach(() => {
  current = makeRecord({ accounts: [{ ...baseAccount }] });
  // Mirror the live D1-backed repo's read-after-write behavior so the cache
  // tests can rely on getById observing the just-persisted state.
  saveStateSpy = vi.fn(async (_id, newState, _opts) => {
    if (current) current = { ...current, state: newState as ClaudeCodeUpstreamState };
    return { updated: true };
  });
  getByIdSpy = vi.fn(async () => current);
  repo = { getById: getByIdSpy, saveState: saveStateSpy };
});

afterEach(() => vi.restoreAllMocks());

describe('ensureClaudeCodeAccessToken', () => {
  test('returns the cached entry when still fresh and never calls fetch', async () => {
    const entry: ClaudeCodeAccessTokenEntry = { token: 'at_x', expiresAt: farFutureMs, refreshedAt: 'now' };
    current = makeRecord({ accounts: [{ ...baseAccount, accessToken: entry }] });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const out = await ensureClaudeCodeAccessToken({ upstreamId, repo, fetcher: directFetcher });
    expect(out).toEqual({ entry, freshlyMinted: false });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(saveStateSpy).not.toHaveBeenCalled();
  });

  test('refreshes when no token is cached, rotates refresh_token via CAS, persists fresh access token', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      access_token: 'at_new', token_type: 'Bearer', expires_in: 3600, refresh_token: 'rt_v2', scope: 'user:inference',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const out = await ensureClaudeCodeAccessToken({ upstreamId, repo, fetcher: directFetcher });
    expect(out.freshlyMinted).toBe(true);
    expect(out.entry.token).toBe('at_new');
    expect(out.entry.expiresAt).toBeGreaterThan(Date.now());

    expect(saveStateSpy).toHaveBeenCalledTimes(1);
    const [, nextState] = saveStateSpy.mock.calls[0];
    const account = (nextState as ClaudeCodeUpstreamState).accounts[0];
    expect(account.refreshToken).toBe('rt_v2');
    expect(account.accessToken?.token).toBe('at_new');
    expect(account.state).toBe('active');
  });

  test('refreshes when the cached token is within the 5-minute skew window', async () => {
    const expiresSoon = Date.now() + 60 * 1000;
    current = makeRecord({ accounts: [{ ...baseAccount, accessToken: { token: 'at_old', expiresAt: expiresSoon, refreshedAt: 'old' } }] });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      access_token: 'at_new', token_type: 'Bearer', expires_in: 3600, refresh_token: 'rt_v2', scope: 'user:inference',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const out = await ensureClaudeCodeAccessToken({ upstreamId, repo, fetcher: directFetcher });
    expect(out.entry.token).toBe('at_new');
    expect(out.freshlyMinted).toBe(true);
  });

  test('invalid_grant with no sibling rotation (stored RT unchanged) → terminal flip', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      error: 'invalid_grant', error_description: 'Refresh token revoked',
    }), { status: 400, headers: { 'content-type': 'application/json' } }));

    await expect(ensureClaudeCodeAccessToken({ upstreamId, repo, fetcher: directFetcher }))
      .rejects.toBeInstanceOf(ClaudeCodeOAuthSessionTerminatedError);

    expect(saveStateSpy).toHaveBeenCalledTimes(1);
    const persisted = saveStateSpy.mock.calls[0][1] as ClaudeCodeUpstreamState;
    expect(persisted.accounts[0].state).toBe('refresh_failed');
    expect(persisted.accounts[0].stateMessage).toContain('Refresh token revoked');
    expect(persisted.accounts[0].accessToken).toBeNull();
  });

  test('invalid_grant with a sibling rotation in flight → returns the sibling-minted access token, no terminal flip', async () => {
    // Simulate the race: between our pre-refresh getById and the upstream
    // rejecting our refresh_token, a sibling worker won the rotation and
    // CAS-wrote rt_v2 + at_sibling. Re-read on recovery observes the new
    // pair; we should return it as a non-freshly-minted entry instead of
    // destroying a working credential.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      error: 'invalid_grant', error_description: 'Refresh token revoked',
    }), { status: 400, headers: { 'content-type': 'application/json' } }));
    const siblingEntry: ClaudeCodeAccessTokenEntry = { token: 'at_sibling', expiresAt: farFutureMs, refreshedAt: 'sibling' };
    getByIdSpy.mockImplementationOnce(async () => current).mockImplementationOnce(async () => {
      // Mutate the shared `current` so subsequent reads also see the rotation,
      // matching the live D1 repo's read-after-write semantics.
      current = makeRecord({ accounts: [{ ...baseAccount, refreshToken: 'rt_v2', accessToken: siblingEntry }] });
      return current;
    });

    const out = await ensureClaudeCodeAccessToken({ upstreamId, repo, fetcher: directFetcher });
    expect(out.entry).toEqual(siblingEntry);
    expect(out.freshlyMinted).toBe(false);
    // No terminal-state persist — the recovery path must not touch state.
    expect(saveStateSpy).not.toHaveBeenCalled();
  });

  test('app_session_terminated never attempts race recovery — always flips to terminal', async () => {
    // `app_session_terminated` signals credential death even under a race
    // scenario, so we should not even re-read state; the terminal flip is
    // unconditional. Assert via the absence of a second getById call.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      error: { code: 'app_session_terminated', message: 'Session ended by Anthropic' },
    }), { status: 400, headers: { 'content-type': 'application/json' } }));

    await expect(ensureClaudeCodeAccessToken({ upstreamId, repo, fetcher: directFetcher }))
      .rejects.toBeInstanceOf(ClaudeCodeOAuthSessionTerminatedError);

    expect(getByIdSpy).toHaveBeenCalledTimes(1);
    expect(saveStateSpy).toHaveBeenCalledTimes(1);
    const persisted = saveStateSpy.mock.calls[0][1] as ClaudeCodeUpstreamState;
    expect(persisted.accounts[0].state).toBe('refresh_failed');
    expect(persisted.accounts[0].stateMessage).toBe('Session ended by Anthropic');
  });

  test('CAS loss on refresh-token rotation surfaces as an error (sibling rotation already won)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      access_token: 'at_new', token_type: 'Bearer', expires_in: 3600, refresh_token: 'rt_v2', scope: 'user:inference',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    saveStateSpy.mockResolvedValueOnce({ updated: false });
    await expect(ensureClaudeCodeAccessToken({ upstreamId, repo, fetcher: directFetcher }))
      .rejects.toThrow(/CAS/);
  });

  test('saveState storage failure propagates without rotating', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      access_token: 'at_new', token_type: 'Bearer', expires_in: 3600, refresh_token: 'rt_v2', scope: 'user:inference',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    saveStateSpy.mockRejectedValueOnce(new Error('D1 boom'));
    await expect(ensureClaudeCodeAccessToken({ upstreamId, repo, fetcher: directFetcher }))
      .rejects.toThrow(/D1 boom/);
  });

  test('throws when the upstream row is missing', async () => {
    current = null;
    await expect(ensureClaudeCodeAccessToken({ upstreamId, repo, fetcher: directFetcher }))
      .rejects.toThrow(/not found/);
  });

  test('throws session-terminated when the stored account is not active', async () => {
    current = makeRecord({
      accounts: [{ ...baseAccount, state: 'refresh_failed', stateMessage: 'previously failed', stateUpdatedAt: 'now' }],
    });
    await expect(ensureClaudeCodeAccessToken({ upstreamId, repo, fetcher: directFetcher }))
      .rejects.toBeInstanceOf(ClaudeCodeOAuthSessionTerminatedError);
  });
});

describe('invalidateClaudeCodeAccessToken', () => {
  test('clears a populated access-token slot', async () => {
    const entry: ClaudeCodeAccessTokenEntry = { token: 'at_x', expiresAt: farFutureMs, refreshedAt: 'now' };
    current = makeRecord({ accounts: [{ ...baseAccount, accessToken: entry }] });
    await invalidateClaudeCodeAccessToken({ upstreamId, repo });
    expect(saveStateSpy).toHaveBeenCalledTimes(1);
    const persisted = saveStateSpy.mock.calls[0][1] as ClaudeCodeUpstreamState;
    expect(persisted.accounts[0].accessToken).toBeNull();
    expect(persisted.accounts[0].refreshToken).toBe('rt_v1');
  });

  test('no-ops when the slot is already null', async () => {
    await invalidateClaudeCodeAccessToken({ upstreamId, repo });
    expect(saveStateSpy).not.toHaveBeenCalled();
  });

  test('throws when the upstream disappeared', async () => {
    current = null;
    await expect(invalidateClaudeCodeAccessToken({ upstreamId, repo })).rejects.toThrow(/disappeared/);
    expect(saveStateSpy).not.toHaveBeenCalled();
  });
});

describe('ensureClaudeCodeAccessToken (within-isolate herd coalescing)', () => {
  test('10 parallel cold-start ensures share a single /v1/oauth/token mint', async () => {
    // Cold-start fan-out: no cached token, N concurrent callers. Without
    // coalescing each would POST to /v1/oauth/token, the upstream would
    // rotate the refresh token under the first, and the rest would fall
    // into recoverFromRefreshRace — correct but N round-trips per cold
    // start. The in-flight map collapses the herd to one mint.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      access_token: 'at_new', token_type: 'Bearer', expires_in: 3600, refresh_token: 'rt_v2', scope: 'user:inference',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        ensureClaudeCodeAccessToken({ upstreamId, repo, fetcher: directFetcher })),
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(saveStateSpy).toHaveBeenCalledTimes(1);
    for (const r of results) {
      expect(r.entry.token).toBe('at_new');
    }
    // Every coalesced waiter reports `freshlyMinted: true` — the contract
    // documented on `EnsuredAccessToken` in access-token-cache.ts is "this
    // call site shared in a real mint," not "drove the mint itself." All
    // ten callers fanned out onto the single in-flight promise here, so
    // all ten observe `freshlyMinted: true`.
    const minted = results.filter(r => r.freshlyMinted).length;
    expect(minted).toBe(10);
  });

  test('serial calls after the in-flight settles are not stuck on a stale entry', async () => {
    // The map entry must be cleared on settle so the second wave can mint
    // again when the upstream rotates / expires. Mint, await settle, then
    // mint again — the second wave should hit fetch a second time
    // (no cached token because the test starts from the cold state).
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      access_token: 'at_new', token_type: 'Bearer', expires_in: 3600, refresh_token: 'rt_v2', scope: 'user:inference',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const first = await ensureClaudeCodeAccessToken({ upstreamId, repo, fetcher: directFetcher });
    expect(first.entry.token).toBe('at_new');
    // Re-arm a stale view so the next ensure triggers another mint rather
    // than hitting the cached-and-fresh early return.
    current = makeRecord({ accounts: [{ ...baseAccount, refreshToken: 'rt_v2' }] });
    const second = await ensureClaudeCodeAccessToken({ upstreamId, repo, fetcher: directFetcher });
    expect(second.entry.token).toBe('at_new');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  test('a rejected in-flight mint propagates to every coalesced waiter and clears the map', async () => {
    // If the in-flight promise rejects, every waiter sees the same
    // rejection — and the entry is cleared so the next caller is free to
    // retry from scratch.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      error: 'invalid_grant', error_description: 'Refresh token revoked',
    }), { status: 400, headers: { 'content-type': 'application/json' } }));

    const waiters = Array.from({ length: 5 }, () =>
      ensureClaudeCodeAccessToken({ upstreamId, repo, fetcher: directFetcher }).catch(e => e));
    const settled = await Promise.all(waiters);
    for (const e of settled) {
      expect(e).toBeInstanceOf(ClaudeCodeOAuthSessionTerminatedError);
    }
    // Only one upstream POST despite 5 waiters.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('ensureClaudeCodeAccessToken (setup-token kind)', () => {
  const setupTokenAccount: ClaudeCodeUpstreamState['accounts'][number] = {
    accountUuid,
    tokenKind: 'setup-token',
    refreshToken: null,
    state: 'active',
    stateUpdatedAt: '2026-06-01T00:00:00.000Z',
    accessToken: { token: 'st_long_lived', expiresAt: farFutureMs, refreshedAt: '2026-06-01T00:00:00.000Z' },
    quotaSnapshot: null,
    usageProbeSnapshot: null,
  };

  test('returns the long-lived bearer when fresh; never hits /v1/oauth/token', async () => {
    current = makeRecord({ accounts: [{ ...setupTokenAccount }] });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const out = await ensureClaudeCodeAccessToken({ upstreamId, repo, fetcher: directFetcher });
    expect(out.entry.token).toBe('st_long_lived');
    expect(out.freshlyMinted).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(saveStateSpy).not.toHaveBeenCalled();
  });

  test('expired setup-token flips to refresh_failed and surfaces session-terminated (operator must re-import)', async () => {
    const expiredEntry: ClaudeCodeAccessTokenEntry = {
      token: 'st_expired', expiresAt: Date.now() - 60 * 1000, refreshedAt: '2025-01-01T00:00:00Z',
    };
    current = makeRecord({ accounts: [{ ...setupTokenAccount, accessToken: expiredEntry }] });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(ensureClaudeCodeAccessToken({ upstreamId, repo, fetcher: directFetcher }))
      .rejects.toBeInstanceOf(ClaudeCodeOAuthSessionTerminatedError);
    // No upstream call — there's nothing to refresh against.
    expect(fetchSpy).not.toHaveBeenCalled();

    expect(saveStateSpy).toHaveBeenCalledTimes(1);
    const persisted = saveStateSpy.mock.calls[0][1] as ClaudeCodeUpstreamState;
    expect(persisted.accounts[0].state).toBe('refresh_failed');
    expect(persisted.accounts[0].stateMessage).toMatch(/re-import/);
    expect(persisted.accounts[0].accessToken).toBeNull();
  });
});
