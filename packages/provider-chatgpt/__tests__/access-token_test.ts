import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createUpstreamStateRepoStub, type UpstreamStateRepoStub } from './upstream-state-repo.ts';
import {
  ensureChatGPTAccessToken,
  mintChatGPTAccessToken,
  putChatGPTAccessToken,
  type ChatGPTAccessTokenEntry,
} from '../src/access-token.ts';
import { ChatGPTOAuthSessionTerminatedError } from '../src/auth/oauth.ts';
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

beforeEach(() => {
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
    const effective = await putChatGPTAccessToken(upstreamId, accountId, older);
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
    await putChatGPTAccessToken(upstreamId, accountId, tokenOnly);
    await putChatGPTAccessToken(upstreamId, accountId, {
      token: 'at_t1',
      expiresAt: farFutureMs,
      refreshedAt: '2026-08-10T00:00:01.000Z',
      planType: 'free',
      planObservedAt: '2026-08-10T00:00:01.000Z',
    });
    const effective = await putChatGPTAccessToken(upstreamId, accountId, {
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
    await expect(putChatGPTAccessToken(upstreamId, accountId, entry)).rejects.toThrow('D1 boom');
  });

  // A minted access token is bookkeeping the next request re-derives, so an
  // operator deleting the upstream mid-request is tolerated. The storage
  // failure above is not — that distinction is the whole point of the typed
  // error.
  test('tolerates an upstream that disappeared mid-flight', async () => {
    current = null;
    const entry: ChatGPTAccessTokenEntry = { token: 'at_new', expiresAt: farFutureMs, refreshedAt: 'now' };
    await putChatGPTAccessToken(upstreamId, accountId, entry);
    expect(repo.writes).toEqual([]);
  });
});

describe('ensureChatGPTAccessToken', () => {

  test('spends an access-only token to its actual expiry, ignoring the renewable skew', async () => {
    const entry: ChatGPTAccessTokenEntry = { token: 'at_only', expiresAt: Date.now() + 60_000, refreshedAt: 'now' };
    current = makeRecord({ accounts: [{ ...baseAccount, refresh_token: null, accessToken: entry }] });
    const mint = vi.fn();
    expect(await ensureChatGPTAccessToken(upstreamId, accountId, mint)).toEqual(entry);
    expect(mint).not.toHaveBeenCalled();
  });

  test('treats an unknown expiry on a renewable credential as unusable', async () => {
    const entry: ChatGPTAccessTokenEntry = { token: 'at_unknown', expiresAt: null, refreshedAt: 'now' };
    current = makeRecord({ accounts: [{ ...baseAccount, accessToken: entry }] });
    const minted: ChatGPTAccessTokenEntry = { token: 'at_minted', expiresAt: farFutureMs, refreshedAt: 'now' };
    const mint = vi.fn().mockResolvedValue(minted);
    expect(await ensureChatGPTAccessToken(upstreamId, accountId, mint)).toEqual(minted);
    expect(mint).toHaveBeenCalledWith('rt_v1');
  });

  test('refuses a forced refresh of an access-only credential', async () => {
    const entry: ChatGPTAccessTokenEntry = { token: 'at_only', expiresAt: null, refreshedAt: 'now' };
    current = makeRecord({ accounts: [{ ...baseAccount, refresh_token: null, accessToken: entry }] });
    const mint = vi.fn();
    await expect(ensureChatGPTAccessToken(upstreamId, accountId, mint, true)).rejects.toThrow(/cannot be refreshed/);
    expect(mint).not.toHaveBeenCalled();
  });

  test('keeps a null account id in a different in-flight slot from the string "null"', async () => {
    current = makeRecord({ accounts: [{ ...baseAccount, chatgptAccountId: null }] });
    const minted: ChatGPTAccessTokenEntry = { token: 'at_minted', expiresAt: farFutureMs, refreshedAt: 'now' };
    const nullAccountEnsure = ensureChatGPTAccessToken(upstreamId, null, vi.fn().mockResolvedValue(minted));
    await expect(ensureChatGPTAccessToken(upstreamId, 'null', vi.fn())).rejects.toThrow(/not found/);
    await expect(nullAccountEnsure).resolves.toEqual(minted);
  });

  test('mints when the cached token is within the refresh skew window', async () => {
    const expiresSoon = Date.now() + 60 * 1000;
    current = makeRecord({ accounts: [{ ...baseAccount, accessToken: { token: 'at_old', expiresAt: expiresSoon, refreshedAt: 'old' } }] });
    const minted: ChatGPTAccessTokenEntry = { token: 'at_minted', expiresAt: farFutureMs, refreshedAt: 'now' };
    const mint = vi.fn().mockResolvedValue(minted);
    const out = await ensureChatGPTAccessToken(upstreamId, accountId, mint);
    expect(out).toEqual(minted);
    expect(mint).toHaveBeenCalledWith('rt_v1');
  });

  test('propagates mint errors without persisting', async () => {
    const mint = vi.fn().mockRejectedValue(new Error('oauth boom'));
    await expect(ensureChatGPTAccessToken(upstreamId, accountId, mint)).rejects.toThrow(/oauth boom/);
    expect(repo.writes).toEqual([]);
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

    const out = await ensureChatGPTAccessToken(upstreamId, accountId, mint);
    expect(out).toEqual(siblingEntry);
    expect(mint).toHaveBeenCalledTimes(1);
    // Recovery returns the sibling's cached token; no fresh persist from us.
    expect(repo.writes).toEqual([]);
  });

  test('invalid_grant with stored RT unchanged → rethrows for the caller to flip to terminal', async () => {
    // Same RT on re-read means no sibling rotated; the refresh_token really
    // is dead. The cache surfaces the original error; the data-plane / control-
    // plane caller is responsible for the terminal-state flip.
    const mint = vi.fn().mockRejectedValue(new ChatGPTOAuthSessionTerminatedError({ code: 'invalid_grant', message: 'revoked' }));
    await expect(ensureChatGPTAccessToken(upstreamId, accountId, mint)).rejects.toBeInstanceOf(ChatGPTOAuthSessionTerminatedError);
    expect(mint).toHaveBeenCalledTimes(1);
    expect(repo.writes).toEqual([]);
  });
});

describe('mintChatGPTAccessToken', () => {
  test('stores the current plan from the refreshed id_token', async () => {
    const idToken = [
      Buffer.from('{}').toString('base64url'),
      Buffer.from(JSON.stringify({
        email: 'a@b.com',
        'https://api.openai.com/auth': {
          chatgpt_account_id: accountId,
          chatgpt_user_id: 'usr',
          chatgpt_plan_type: 'team',
        },
      })).toString('base64url'),
      Buffer.from('signature').toString('base64url'),
    ].join('.');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      access_token: 'at', refresh_token: 'rt_v2', id_token: idToken, expires_in: 600,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const persistRotation = vi.fn(async () => {});
    const entry = await mintChatGPTAccessToken('rt_v1', directFetcher, persistRotation);
    expect(entry.planType).toBe('team');
    expect(entry.planObservedAt).toBe(entry.refreshedAt);
    expect(persistRotation).toHaveBeenCalledWith('rt_v2');
  });

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
    await expect(mintChatGPTAccessToken('rt_v1', directFetcher, persistRotation)).rejects.toThrow(/chatgpt_plan_type/);
    expect(persistRotation).toHaveBeenCalledWith('rt_v2');
  });
});
