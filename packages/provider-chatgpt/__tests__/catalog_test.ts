import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createUpstreamStateRepoStub, type UpstreamStateRepoStub } from './upstream-state-repo.ts';
import { getChatGPTProvidedModels } from '../src/catalog.ts';
import type { ChatGPTAccessTokenEntry, ChatGPTUpstreamState } from '../src/state.ts';
import { directFetcher, initProviderRepo, type UpstreamRecord } from '@floway-dev/provider';

const farFutureMs = Date.now() + 24 * 60 * 60 * 1000;

const freshAccessToken: ChatGPTAccessTokenEntry = { token: 'at', expiresAt: farFutureMs, refreshedAt: 'now' };

const baseRecord: UpstreamRecord = {
  id: 'up_chatgpt',
  kind: 'chatgpt',
  name: 'ChatGPT Plus',
  enabled: true,
  usageRefreshIntervalMinutes: 0,
  sortOrder: 0,
  createdAt: '2026-06-05T00:00:00.000Z',
  updatedAt: '2026-06-05T00:00:00.000Z',
  config: { accounts: [{ email: 'a@b.com', chatgptAccountId: 'acc', chatgptUserId: 'usr', planType: 'plus' }] },
  state: { accounts: [{ chatgptAccountId: 'acc', refresh_token: 'rt_v1', state: 'active', state_updated_at: '2026-01-01T00:00:00Z', openaiDeviceId: '11111111-2222-4333-8444-555555555555', accessToken: null, quotaSnapshot: null }] },
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  modelsCache: null,
  hue: 210,
};

const recordWithAccessToken = (entry: ChatGPTAccessTokenEntry = freshAccessToken): UpstreamRecord => ({
  ...baseRecord,
  state: { accounts: [{ chatgptAccountId: 'acc', refresh_token: 'rt_v1', state: 'active', state_updated_at: '2026-01-01T00:00:00Z', openaiDeviceId: '11111111-2222-4333-8444-555555555555', accessToken: entry, quotaSnapshot: null }] },
});

let current: UpstreamRecord | null;
let repo: UpstreamStateRepoStub;

beforeEach(() => {
  current = recordWithAccessToken();
  repo = createUpstreamStateRepoStub(() => current, state => {
    current = { ...current!, state: state as ChatGPTUpstreamState };
  });
  initProviderRepo(() => ({ recordUpstreamMetric: async () => {}, upstreams: repo }));
});

afterEach(() => vi.restoreAllMocks());

const modelsResponse = (): Response => new Response(JSON.stringify({
  models: [
    { slug: 'gpt-5.4', display_name: 'GPT-5.4', visibility: 'list', context_window: 272000, max_context_window: 1000000, use_responses_lite: false },
    { slug: 'codex-auto-review', display_name: 'Codex Auto Review', visibility: 'hide', context_window: 272000, max_context_window: 1000000, use_responses_lite: true },
  ],
}), { status: 200, headers: new Headers({ 'content-type': 'application/json' }) });

const idToken = (planType = 'plus'): string => [
  Buffer.from('{}').toString('base64url'),
  Buffer.from(JSON.stringify({
    email: 'a@b.com',
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'acc',
      chatgpt_user_id: 'usr',
      chatgpt_plan_type: planType,
    },
  })).toString('base64url'),
  Buffer.from('signature').toString('base64url'),
].join('.');

const oauthTokenResponse = (overrides: Partial<{ access_token: string; refresh_token: string; expires_in: number }> = {}): Response => new Response(JSON.stringify({
  access_token: overrides.access_token ?? 'at_minted',
  refresh_token: overrides.refresh_token ?? 'rt_v2',
  id_token: idToken(),
  expires_in: overrides.expires_in ?? 3600,
}), { status: 200, headers: new Headers({ 'content-type': 'application/json' }) });

describe('getChatGPTProvidedModels', () => {
  test('getProvidedModels uses the cached access token when fresh and surfaces every catalog entry', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(modelsResponse());
    const models = await getChatGPTProvidedModels(baseRecord, directFetcher);
    // Provider surfaces both visible and hidden upstream models — operators
    // can dispatch to `codex-auto-review` even though ChatGPT's UI hides it.
    expect(models.map(m => m.id)).toEqual(['gpt-5.4', 'codex-auto-review', 'gpt-image-2']);
    expect(models[0].endpoints).toEqual({ openaiResponses: {} });
    expect(models[0].providerData).toEqual({ contextWindow: 272000, useResponsesLite: false });
    expect(models[1].providerData).toEqual({ contextWindow: 272000, useResponsesLite: true });
    expect(models[2]).toMatchObject({ kind: 'image', endpoints: { openaiImagesGenerations: {}, openaiImagesEdits: {} } });
  });

  test('getProvidedModels mints an access token when none is cached, then fetches the catalog', async () => {
    current = baseRecord;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input as Request).url);
      if (url.includes('/oauth/token')) return oauthTokenResponse();
      if (url.includes('/codex/models')) return modelsResponse();
      throw new Error(`unexpected fetch ${url}`);
    });
    const models = await getChatGPTProvidedModels(baseRecord, directFetcher);
    expect(models.map(m => m.id)).toEqual(['gpt-5.4', 'codex-auto-review', 'gpt-image-2']);
    const urls = fetchSpy.mock.calls.map(c => typeof c[0] === 'string' ? c[0] : (c[0] as URL | Request).toString());
    expect(urls.some(u => u.includes('/oauth/token'))).toBe(true);
    expect(urls.some(u => u.includes('/codex/models'))).toBe(true);
    // A mint writes twice into the same account slot: the rotated
    // refresh_token from the OAuth response, then the freshly minted access
    // token. Both changes must survive for the next caller to see a usable
    // credential pair, which is what the second write applying on top of the
    // first proves.
    const account = (current!.state as ChatGPTUpstreamState).accounts[0];
    expect(account.refresh_token).toBe('rt_v2');
    expect(account.accessToken?.token).toBe('at_minted');
  });

  test('getProvidedModels uses the refreshed access-token plan over import-time config', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => modelsResponse());
    current = recordWithAccessToken({ ...freshAccessToken, planType: 'free' });
    const downgraded = await getChatGPTProvidedModels(baseRecord, directFetcher);
    expect(downgraded.map(model => model.id)).not.toContain('gpt-image-2');

    const importedFree: UpstreamRecord = {
      ...baseRecord,
      config: { accounts: [{ email: 'a@b.com', chatgptAccountId: 'acc', chatgptUserId: 'usr', planType: 'free' }] },
    };
    current = recordWithAccessToken({ ...freshAccessToken, planType: 'plus' });
    const upgraded = await getChatGPTProvidedModels(importedFree, directFetcher);
    expect(upgraded.map(model => model.id)).toContain('gpt-image-2');
  });
});
