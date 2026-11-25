import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { ClaudeCodeOAuthSessionTerminatedError } from '../src/auth/oauth.ts';
import type { ClaudeCodeUpstreamConfig } from '../src/config.ts';
import { createClaudeCodeService, type ClaudeCodeService } from '../src/service.ts';
import type { ClaudeCodeAccessTokenEntry, ClaudeCodeQuotaSnapshotEntry, ClaudeCodeUpstreamState } from '../src/state.ts';
import { directFetcher, UpstreamGoneError, type UpstreamRecord } from '@floway-dev/provider';

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
  usageRefreshIntervalMinutes: 0,
  sortOrder: 0,
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
  config: baseConfig,
  state,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  modelsCache: null,
  hue: 210,
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

type SaveStateSpy = ReturnType<typeof vi.fn<(id: string, mutate: (current: unknown) => unknown) => Promise<void>>>;
type GetByIdSpy = ReturnType<typeof vi.fn<(id: string) => Promise<UpstreamRecord | null>>>;

let current: UpstreamRecord | null;
// The states the stub repo actually committed, in order. A mutator that
// returns its argument unchanged serializes back to the stored text, which the
// live repo turns into a no-op, so this records intent-to-write rather than
// call count.
let writes: ClaudeCodeUpstreamState[];
let saveStateSpy: SaveStateSpy;
let getByIdSpy: GetByIdSpy;
let claudeCode: ClaudeCodeService;

beforeEach(() => {
  current = makeRecord({ accounts: [{ ...baseAccount }] });
  writes = [];
  // Mirror the live D1-backed repo: read the stored state, hand it to the
  // mutator, skip the write when the result serializes identically, and fail a
  // write against a row that is gone. Read-after-write matters for the cache
  // tests, which rely on getById observing the just-persisted state.
  saveStateSpy = vi.fn(async (id, mutate) => {
    if (!current) throw new UpstreamGoneError(id);
    const next = mutate(current.state) as ClaudeCodeUpstreamState;
    if (JSON.stringify(next) === JSON.stringify(current.state)) return;
    current = { ...current, state: next };
    writes.push(next);
  });
  getByIdSpy = vi.fn(async () => current);
  claudeCode = createClaudeCodeService({
    recordUpstreamMetric: async () => {},
    upstreams: {
      getById: async id => {
        const record = await getByIdSpy(id);
        return record === null ? null : { ...record, configVersion: 1 };
      },
      saveState: (id, mutate) => saveStateSpy(id, current => mutate(current, 1)),
    },
  });
});

afterEach(() => vi.restoreAllMocks());

describe('ensureClaudeCodeAccessToken', () => {
  test('refreshes when no token is cached, rotates refresh_token, persists fresh access token', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      access_token: 'at_new', token_type: 'Bearer', expires_in: 3600, refresh_token: 'rt_v2', scope: 'user:inference',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const out = await claudeCode.ensureAccessToken({ upstreamId, fetcher: directFetcher });
    expect(out.freshlyMinted).toBe(true);
    expect(out.entry.token).toBe('at_new');
    expect(out.entry.expiresAt).toBeGreaterThan(Date.now());

    const account = writes[0].accounts[0];
    expect(account.refreshToken).toBe('rt_v2');
    expect(account.accessToken?.token).toBe('at_new');
    expect(account.state).toBe('active');
  });

  test('rotation lands on the state a concurrent quota write left behind', async () => {
    // The row also carries values written on every data-plane response, so a
    // quota snapshot routinely lands between our read and our write. The
    // rotation is derived from whatever the repo hands the mutator, so both
    // changes survive.
    const siblingQuota: ClaudeCodeQuotaSnapshotEntry = {
      fetchedAt: 1781805000000,
      data: {
        status: 'allowed',
        reset: null,
        fallbackAvailable: null,
        fallbackPercentage: null,
        representativeClaim: null,
        overage: null,
        fiveHour: null,
        sevenDay: null,
        raw: { 'anthropic-ratelimit-unified-status': 'allowed' },
      },
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      current = makeRecord({ accounts: [{ ...baseAccount, quotaSnapshot: siblingQuota }] });
      return new Response(JSON.stringify({
        access_token: 'at_new', token_type: 'Bearer', expires_in: 3600, refresh_token: 'rt_v2', scope: 'user:inference',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    await claudeCode.ensureAccessToken({ upstreamId, fetcher: directFetcher });

    expect(writes).toHaveLength(1);
    const account = writes[0].accounts[0];
    expect(account.refreshToken).toBe('rt_v2');
    expect(account.accessToken?.token).toBe('at_new');
    expect(account.quotaSnapshot).toEqual(siblingQuota);
  });

  test('invalid_grant with no sibling rotation (stored RT unchanged) → terminal flip', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      error: 'invalid_grant', error_description: 'Refresh token revoked',
    }), { status: 400, headers: { 'content-type': 'application/json' } }));

    await expect(claudeCode.ensureAccessToken({ upstreamId, fetcher: directFetcher }))
      .rejects.toBeInstanceOf(ClaudeCodeOAuthSessionTerminatedError);

    expect(writes).toHaveLength(1);
    const persisted = writes[0];
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

    const out = await claudeCode.ensureAccessToken({ upstreamId, fetcher: directFetcher });
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

    await expect(claudeCode.ensureAccessToken({ upstreamId, fetcher: directFetcher }))
      .rejects.toBeInstanceOf(ClaudeCodeOAuthSessionTerminatedError);

    expect(getByIdSpy).toHaveBeenCalledTimes(1);
    expect(writes).toHaveLength(1);
    const persisted = writes[0];
    expect(persisted.accounts[0].state).toBe('refresh_failed');
    expect(persisted.accounts[0].stateMessage).toBe('Session ended by Anthropic');
  });
});

describe('Claude Code refresh coalescing per service', () => {
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
        claudeCode.ensureAccessToken({ upstreamId, fetcher: directFetcher })),
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(saveStateSpy).toHaveBeenCalledTimes(1);
    for (const r of results) {
      expect(r.entry.token).toBe('at_new');
    }
    // Every coalesced waiter reports `freshlyMinted: true` — the contract
    // documented on `EnsuredAccessToken` in access-token.ts is "this
    // call site shared in a real mint," not "drove the mint itself." All
    // ten callers fanned out onto the single in-flight promise here, so
    // all ten observe `freshlyMinted: true`.
    const minted = results.filter(r => r.freshlyMinted).length;
    expect(minted).toBe(10);
  });

  test('uses separate credentials and writes for the same upstream ID in distinct services', async () => {
    const firstStarted = Promise.withResolvers<void>();
    const finishFirst = Promise.withResolvers<void>();
    let otherState: ClaudeCodeUpstreamState = { accounts: [{ ...baseAccount, refreshToken: 'other-old' }] };
    const other = createClaudeCodeService({
      recordUpstreamMetric: async () => {},
      upstreams: {
        getById: async () => ({ ...makeRecord(otherState), configVersion: 1 }),
        saveState: async (_id, mutate) => { otherState = mutate(otherState, 1) as ClaudeCodeUpstreamState; },
      },
    });
    const first = claudeCode.ensureAccessToken({
      upstreamId,
      fetcher: async () => {
        firstStarted.resolve();
        await finishFirst.promise;
        return Response.json({ access_token: 'first-access', token_type: 'Bearer', expires_in: 3600, refresh_token: 'first-new', scope: 'user:inference' });
      },
    });
    await firstStarted.promise;
    const secondFetcher = vi.fn(async () => Response.json({ access_token: 'second-access', token_type: 'Bearer', expires_in: 3600, refresh_token: 'second-new', scope: 'user:inference' }));
    const second = other.ensureAccessToken({ upstreamId, fetcher: secondFetcher });
    finishFirst.resolve();
    const result = await Promise.all([first, second]);
    expect(result.map(({ entry }) => entry.token)).toEqual(['first-access', 'second-access']);
    expect(secondFetcher).toHaveBeenCalledOnce();
    expect(writes[0].accounts[0].refreshToken).toBe('first-new');
    expect(otherState.accounts[0].refreshToken).toBe('second-new');
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

  test('expired setup-token flips to refresh_failed and surfaces session-terminated (operator must re-import)', async () => {
    const expiredEntry: ClaudeCodeAccessTokenEntry = {
      token: 'st_expired', expiresAt: Date.now() - 60 * 1000, refreshedAt: '2025-01-01T00:00:00Z',
    };
    current = makeRecord({ accounts: [{ ...setupTokenAccount, accessToken: expiredEntry }] });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(claudeCode.ensureAccessToken({ upstreamId, fetcher: directFetcher }))
      .rejects.toBeInstanceOf(ClaudeCodeOAuthSessionTerminatedError);
    // No upstream call — there's nothing to refresh against.
    expect(fetchSpy).not.toHaveBeenCalled();

    expect(writes).toHaveLength(1);
    const persisted = writes[0];
    expect(persisted.accounts[0].state).toBe('refresh_failed');
    expect(persisted.accounts[0].accessToken).toBeNull();
  });
});
