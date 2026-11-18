import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createUpstreamStateRepoStub, type UpstreamStateRepoStub } from './upstream-state-repo.ts';
import { createChatGPTProvider } from '../src/provider.ts';
import type { ChatGPTAccessTokenEntry, ChatGPTUpstreamState } from '../src/state.ts';
import { directFetcher, initProviderRepo, type UpstreamRecord } from '@floway-dev/provider';
import { noopUpstreamCallOptions, readJsonRequest, stubProviderModel } from '@floway-dev/test-utils';

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

const sseResponse = (): Response => new Response(
  new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode('event: response.created\ndata: {"type":"response.created","response":{"id":"r","object":"response","model":"gpt-5.4","status":"in_progress","output":[],"incomplete_details":null,"error":null}}\n\n'));
      c.enqueue(new TextEncoder().encode('event: response.completed\ndata: {"type":"response.completed","response":{"id":"r","object":"response","model":"gpt-5.4","status":"completed","output":[],"incomplete_details":null,"error":null}}\n\n'));
      c.close();
    },
  }),
  { status: 200, headers: new Headers({ 'content-type': 'text/event-stream' }) },
);

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

describe('createChatGPTProvider', () => {
  test('getProvidedModels uses the cached access token when fresh and surfaces every catalog entry', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(modelsResponse());
    const instance = createChatGPTProvider(baseRecord);
    const models = await instance.instance.getProvidedModels(directFetcher);
    // Provider surfaces both visible and hidden upstream models — operators
    // can dispatch to `codex-auto-review` even though ChatGPT's UI hides it.
    expect(models.map(m => m.id)).toEqual(['gpt-5.4', 'codex-auto-review', 'gpt-image-2']);
    expect(models[0].endpoints).toEqual({ openaiResponses: {} });
    expect(models[0].providerData).toEqual({ contextWindow: 272000, useResponsesLite: false });
    expect(models[1].providerData).toEqual({ contextWindow: 272000, useResponsesLite: true });
    expect(models[2]).toMatchObject({ kind: 'image', endpoints: { openaiImagesGenerations: {}, openaiImagesEdits: {} } });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toMatch(/\/codex\/models/);
  });

  test('getProvidedModels mints an access token when none is cached, then fetches the catalog', async () => {
    current = baseRecord;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input as Request).url);
      if (url.includes('/oauth/token')) return oauthTokenResponse();
      if (url.includes('/codex/models')) return modelsResponse();
      throw new Error(`unexpected fetch ${url}`);
    });
    const instance = createChatGPTProvider(baseRecord);
    const models = await instance.instance.getProvidedModels(directFetcher);
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
    const downgraded = await createChatGPTProvider(baseRecord).instance.getProvidedModels(directFetcher);
    expect(downgraded.map(model => model.id)).not.toContain('gpt-image-2');

    const importedFree: UpstreamRecord = {
      ...baseRecord,
      config: { accounts: [{ email: 'a@b.com', chatgptAccountId: 'acc', chatgptUserId: 'usr', planType: 'free' }] },
    };
    current = recordWithAccessToken({ ...freshAccessToken, planType: 'plus' });
    const upgraded = await createChatGPTProvider(importedFree).instance.getProvidedModels(directFetcher);
    expect(upgraded.map(model => model.id)).toContain('gpt-image-2');
  });

  test('callOpenAIResponses preserves developer messages on the Codex wire', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    const instance = createChatGPTProvider(baseRecord);
    const result = await instance.instance.callOpenAIResponses(
      stubProviderModel({ id: 'gpt-5.4', display_name: 'gpt-5.4', endpoints: { openaiResponses: {} } }),
      {
        input: [
          { type: 'message', role: 'developer', content: 'base instructions' },
          { type: 'message', role: 'user', content: 'hi' },
          { type: 'message', role: 'developer', content: 'inline instructions' },
        ],
        stream: true,
      },
      'generate',
      undefined,
      noopUpstreamCallOptions(),
    );
    expect(result.ok).toBe(true);
    expect(result.action).toBe('generate');
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    if (init === undefined) throw new Error('expected a ChatGPT upstream request');
    const body = await readJsonRequest(init) as Record<string, unknown>;
    expect(body.instructions).toBe("You're a helpful assistant.");
    expect(body.input).toEqual([
      { type: 'message', role: 'developer', content: 'base instructions' },
      { type: 'message', role: 'user', content: 'hi' },
      { type: 'message', role: 'developer', content: 'inline instructions' },
    ]);
  });

  test('callOpenAIImagesEdits sends uploads as JSON data URLs to the ChatGPT Codex endpoint', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      created: 1,
      data: [{ b64_json: 'ZWRpdA==' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const instance = createChatGPTProvider(baseRecord);
    const model = stubProviderModel({ id: 'gpt-image-2', display_name: 'GPT-Image-2', kind: 'image', endpoints: { openaiImagesGenerations: {}, openaiImagesEdits: {} } });
    const options = noopUpstreamCallOptions();
    options.headers.set('originator', 'chatgpt_cca');
    const result = await instance.instance.callOpenAIImagesEdits(model, {
      images: [{ type: 'upload', file: new File(['image'], 'image.png', { type: 'image/png' }) }],
      parameters: { prompt: 'make it blue' },
    }, undefined, options);
    expect(result.response.status).toBe(200);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://chatgpt.com/backend-api/codex/images/edits');
    expect(new Headers((init as RequestInit).headers).get('originator')).toBe('chatgpt_cca');
    expect(await readJsonRequest(init as RequestInit)).toEqual({
      prompt: 'make it blue',
      images: [{ image_url: 'data:image/png;base64,aW1hZ2U=' }],
      model: 'gpt-image-2',
    });
  });
});
