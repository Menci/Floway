import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createUpstreamStateRepoStub, type UpstreamStateRepoStub } from './upstream-state-repo.ts';
import { createChatGPTProvider } from '../src/provider.ts';
import type { ChatGPTAccessTokenEntry, ChatGPTUpstreamState } from '../src/state.ts';
import { directFetcher, initProviderRepo, type UpstreamRecord } from '@floway-dev/provider';

const freshAccessToken: ChatGPTAccessTokenEntry = {
  token: 'at',
  expiresAt: Date.now() + 24 * 60 * 60 * 1000,
  refreshedAt: 'now',
};

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

let current: UpstreamRecord;
let repo: UpstreamStateRepoStub;

beforeEach(() => {
  current = recordWithAccessToken();
  repo = createUpstreamStateRepoStub(() => current, state => {
    current = { ...current, state: state as ChatGPTUpstreamState };
  });
  initProviderRepo(() => ({ recordUpstreamMetric: async () => {}, upstreams: repo }));
});

afterEach(() => vi.restoreAllMocks());

const modelsResponse = (): Response => Response.json({
  models: [
    { slug: 'gpt-5.4', display_name: 'GPT-5.4', visibility: 'list', context_window: 272000, max_context_window: 1000000, use_responses_lite: false },
    { slug: 'codex-auto-review', display_name: 'Codex Auto Review', visibility: 'hide', context_window: 272000, max_context_window: 1000000, use_responses_lite: true },
  ],
});

const idToken = (planType = 'plus'): string => [
  Buffer.from('{}').toString('base64url'),
  Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_plan_type: planType } })).toString('base64url'),
  Buffer.from('signature').toString('base64url'),
].join('.');

const oauthTokenResponse = (): Response => Response.json({
  access_token: 'at_minted',
  refresh_token: 'rt_v2',
  id_token: idToken(),
  expires_in: 3600,
});

describe('createChatGPTProvider', () => {
  test('getProvidedModels surfaces every catalog entry and the image model', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => modelsResponse());
    const provider = createChatGPTProvider(baseRecord);
    const models = await provider.instance.getProvidedModels(directFetcher);

    expect(models.map(model => model.id)).toEqual(['gpt-5.4', 'codex-auto-review', 'gpt-image-2']);
    expect(models[0].providerData).toEqual({ contextWindow: 272000, useResponsesLite: false });
    expect(models[1].providerData).toEqual({ contextWindow: 272000, useResponsesLite: true });
    expect(models[2]).toMatchObject({ kind: 'image', endpoints: { openaiImagesGenerations: {}, openaiImagesEdits: {} } });
    expect(provider.pipelines.openaiResponses !== undefined).toBe(true);
    expect(provider.pipelines.alphaSearch !== undefined).toBe(true);
  });

  test('getProvidedModels mints and persists a credential pair when none is cached', async () => {
    current = baseRecord;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/oauth/token')) return oauthTokenResponse();
      if (url.includes('/codex/models')) return modelsResponse();
      throw new Error(`unexpected fetch ${url}`);
    });
    const provider = createChatGPTProvider(baseRecord);
    const models = await provider.instance.getProvidedModels(directFetcher);

    expect(models.map(model => model.id)).toEqual(['gpt-5.4', 'codex-auto-review', 'gpt-image-2']);
    expect(fetchSpy.mock.calls.some(([input]) => String(input).includes('/oauth/token'))).toBe(true);
    expect(fetchSpy.mock.calls.some(([input]) => String(input).includes('/codex/models'))).toBe(true);
    const account = (current.state as ChatGPTUpstreamState).accounts[0];
    expect(account.refresh_token).toBe('rt_v2');
    expect(account.accessToken?.token).toBe('at_minted');
  });

  test('getProvidedModels prefers the current token plan over import-time config', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => modelsResponse());
    current = recordWithAccessToken({ ...freshAccessToken, planType: 'free' });
    const downgraded = await createChatGPTProvider(baseRecord).instance.getProvidedModels(directFetcher);
    expect(downgraded.map(model => model.id)).not.toContain('gpt-image-2');

    current = recordWithAccessToken({ ...freshAccessToken, planType: 'plus' });
    const importedFree: UpstreamRecord = {
      ...baseRecord,
      config: { accounts: [{ email: 'a@b.com', chatgptAccountId: 'acc', chatgptUserId: 'usr', planType: 'free' }] },
    };
    const upgraded = await createChatGPTProvider(importedFree).instance.getProvidedModels(directFetcher);
    expect(upgraded.map(model => model.id)).toContain('gpt-image-2');
  });
});
