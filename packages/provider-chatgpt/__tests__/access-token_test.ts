import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createUpstreamStateRepoStub, type UpstreamStateRepoStub } from './upstream-state-repo.ts';
import {
  mintChatGPTAccessToken,
  type ChatGPTAccessTokenEntry,
} from '../src/access-token.ts';
import { ChatGPTOAuthSessionTerminatedError } from '../src/auth/oauth.ts';
import { toChatGPTUpstreamFacts } from '../src/config.ts';
import { createChatGPTService, type ChatGPTService } from '../src/service.ts';
import type { ChatGPTUpstreamState } from '../src/state.ts';
import { directFetcher, initProviderRepo, type UpstreamRecord } from '@floway-dev/provider';

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
  accessToken: null as ChatGPTAccessTokenEntry | null,
  quotaSnapshot: null,
};

const farFutureMs = Date.now() + 24 * 60 * 60 * 1000;

let current: UpstreamRecord | null;
let repo: UpstreamStateRepoStub;
let service: ChatGPTService;

beforeEach(() => {
  service = createChatGPTService();
  current = makeRecord({ accounts: [{ ...baseAccount }] });
  // Write-through, so a subsequent read observes what the last write landed.
  repo = createUpstreamStateRepoStub(() => current, state => {
    current = { ...current!, state: state as ChatGPTUpstreamState };
  });
  initProviderRepo(() => ({ recordUpstreamMetric: async () => {}, upstreams: repo }));
});

afterEach(() => vi.restoreAllMocks());

const storedState = (): ChatGPTUpstreamState => current!.state as ChatGPTUpstreamState;

describe('putChatGPTAccessToken', () => {
  test('an older explicit plan observation cannot replace a newer one', async () => {
    const newer: ChatGPTAccessTokenEntry = {
      token: 'at_newer',
      expiresAt: farFutureMs,
      refreshedAt: '2026-08-10T00:00:02.000Z',
      planType: 'free',
    };
    current = makeRecord({ accounts: [{ ...baseAccount, accessToken: newer }] });
    const older: ChatGPTAccessTokenEntry = {
      token: 'at_older',
      expiresAt: farFutureMs,
      refreshedAt: '2026-08-10T00:00:01.000Z',
      planType: 'team',
    };
    const effective = await service.putAccessToken(upstreamId, accountId, older);
    const expected = { ...newer, planObservedAt: newer.refreshedAt };
    expect(effective).toEqual(expected);
    expect(storedState().accounts[0].accessToken).toEqual(expected);
  });

  test('orders token and explicit plan observations independently', async () => {
    const tokenOnly: ChatGPTAccessTokenEntry = {
      token: 'at_t3',
      expiresAt: farFutureMs,
      refreshedAt: '2026-08-10T00:00:03.000Z',
    };
    await service.putAccessToken(upstreamId, accountId, tokenOnly);
    await service.putAccessToken(upstreamId, accountId, {
      token: 'at_t1',
      expiresAt: farFutureMs,
      refreshedAt: '2026-08-10T00:00:01.000Z',
      planType: 'free',
      planObservedAt: '2026-08-10T00:00:01.000Z',
    });
    const effective = await service.putAccessToken(upstreamId, accountId, {
      token: 'at_t2',
      expiresAt: farFutureMs,
      refreshedAt: '2026-08-10T00:00:02.000Z',
      planType: 'plus',
      planObservedAt: '2026-08-10T00:00:02.000Z',
    });
    expect(effective).toEqual({
      ...tokenOnly,
      planType: 'plus',
      planObservedAt: '2026-08-10T00:00:02.000Z',
    });
    expect(storedState().accounts[0].accessToken).toEqual(effective);
  });

  test('propagates storage failures so the request path surfaces them', async () => {
    repo.saveState.mockRejectedValueOnce(new Error('D1 boom'));
    const entry: ChatGPTAccessTokenEntry = { token: 'at_new', expiresAt: farFutureMs, refreshedAt: 'now' };
    await expect(service.putAccessToken(upstreamId, accountId, entry)).rejects.toThrow('D1 boom');
  });

});

describe('ensureChatGPTAccessToken', () => {
  test('spends an access-only token to its actual expiry, ignoring the renewable skew', async () => {
    const entry: ChatGPTAccessTokenEntry = { token: 'at_only', expiresAt: Date.now() + 60_000, refreshedAt: 'now' };
    current = makeRecord({ accounts: [{ ...baseAccount, refresh_token: null, accessToken: entry }] });
    const mint = vi.fn();
    expect(await service.ensureAccessToken(upstreamId, accountId, mint)).toEqual(entry);
    expect(mint).not.toHaveBeenCalled();
  });

  test('treats an unknown expiry on a renewable credential as unusable', async () => {
    const entry: ChatGPTAccessTokenEntry = { token: 'at_unknown', expiresAt: null, refreshedAt: 'now' };
    current = makeRecord({ accounts: [{ ...baseAccount, accessToken: entry }] });
    const minted: ChatGPTAccessTokenEntry = { token: 'at_minted', expiresAt: farFutureMs, refreshedAt: 'now' };
    const mint = vi.fn().mockResolvedValue(minted);
    expect(await service.ensureAccessToken(upstreamId, accountId, mint)).toEqual(minted);
    expect(mint).toHaveBeenCalledWith('rt_v1');
  });

  test('refuses a forced refresh of an access-only credential', async () => {
    const entry: ChatGPTAccessTokenEntry = { token: 'at_only', expiresAt: null, refreshedAt: 'now' };
    current = makeRecord({ accounts: [{ ...baseAccount, refresh_token: null, accessToken: entry }] });
    const mint = vi.fn();
    await expect(service.ensureAccessToken(upstreamId, accountId, mint, true)).rejects.toThrow();
    expect(mint).not.toHaveBeenCalled();
  });

  test('keeps a null account id in a different in-flight slot from the string "null"', async () => {
    current = makeRecord({ accounts: [{ ...baseAccount, chatgptAccountId: null }] });
    const minted: ChatGPTAccessTokenEntry = { token: 'at_minted', expiresAt: farFutureMs, refreshedAt: 'now' };
    const nullAccountEnsure = service.ensureAccessToken(upstreamId, null, vi.fn().mockResolvedValue(minted));
    await expect(service.ensureAccessToken(upstreamId, 'null', vi.fn())).rejects.toThrow();
    await expect(nullAccountEnsure).resolves.toEqual(minted);
  });

  test('invalid_grant with a sibling rotation in flight → returns the sibling-minted access token, no persist', async () => {
    // Simulate the race: between our pre-mint read and the upstream rejecting
    // our refresh_token, a sibling worker won the rotation and wrote rt_v2 +
    // at_sibling. Re-read on recovery observes the new pair scoped to the same
    // accountId; we should return it instead of destroying a working
    // credential.
    const siblingEntry: ChatGPTAccessTokenEntry = { token: 'at_sibling', expiresAt: farFutureMs, refreshedAt: 'sibling' };
    repo.getById.mockImplementationOnce(async () => current === null ? null : { ...current, configVersion: 1 }).mockImplementationOnce(async () => {
      current = makeRecord({ accounts: [{ ...baseAccount, refresh_token: 'rt_v2', accessToken: siblingEntry }] });
      return { ...current, configVersion: 1 };
    });
    const mint = vi.fn().mockRejectedValue(new ChatGPTOAuthSessionTerminatedError({ code: 'invalid_grant', message: 'replayed' }));

    const out = await service.ensureAccessToken(upstreamId, accountId, mint);
    expect(out).toEqual(siblingEntry);
    // Recovery returns the sibling's cached token; no fresh persist from us.
    expect(repo.writes).toEqual([]);
  });

  test('invalid_grant with stored RT unchanged → rethrows for the caller to flip to terminal', async () => {
    // Same RT on re-read means no sibling rotated; the refresh_token really
    // is dead. The cache surfaces the original error; the data-plane / control-
    // plane caller is responsible for the terminal-state flip.
    const mint = vi.fn().mockRejectedValue(new ChatGPTOAuthSessionTerminatedError({ code: 'invalid_grant', message: 'revoked' }));
    await expect(service.ensureAccessToken(upstreamId, accountId, mint)).rejects.toBeInstanceOf(ChatGPTOAuthSessionTerminatedError);
    expect(repo.writes).toEqual([]);
  });
});

describe('mintChatGPTAccessToken', () => {
  test('persists a rotated refresh token before surfacing malformed plan metadata', async () => {
    const idToken = [
      Buffer.from('{}').toString('base64url'),
      Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_plan_type: 42 } })).toString('base64url'),
      Buffer.from('signature').toString('base64url'),
    ].join('.');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      access_token: 'at', refresh_token: 'rt_v2', id_token: idToken, expires_in: 600,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const persistRotation = vi.fn(async () => {});
    await expect(mintChatGPTAccessToken('rt_v1', directFetcher, persistRotation)).rejects.toThrow();
    expect(persistRotation).toHaveBeenCalledWith('rt_v2');
  });
});

test('one cancelled waiter leaves a shared OAuth rotation available to another waiter', async () => {
  const upstream = toChatGPTUpstreamFacts(current!);
  const oauth = Promise.withResolvers<Response>();
  const fetcher = vi.fn(() => oauth.promise);
  const controller = new AbortController();
  const request = { upstream, fetcher, now: Date.now(), operation: 'codex' as const };

  const first = service.access({ ...request, signal: controller.signal });
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  const second = service.access(request);
  await vi.waitFor(() => expect(repo.getById).toHaveBeenCalledTimes(2));

  const cancellation = new Error('client disconnected');
  const cancelled = expect(first).rejects.toBe(cancellation);
  controller.abort(cancellation);
  await cancelled;
  oauth.resolve(Response.json({ access_token: 'at_shared', refresh_token: 'rt_shared', expires_in: 600 }));
  const decision = await second;

  expect(decision.kind).toBe('active');
  if (decision.kind === 'active') expect(decision.token.reveal()).toBe('at_shared');
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(repo.writes).toHaveLength(1);
  expect(storedState().accounts[0]).toMatchObject({ refresh_token: 'rt_shared', accessToken: { token: 'at_shared' } });
});
