import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createUpstreamStateRepoStub, type UpstreamStateRepoStub } from './upstream-state-repo.ts';
import { createCodexProvider } from '../src/provider.ts';
import type { CodexAccessTokenEntry, CodexUpstreamState } from '../src/state.ts';
import { directFetcher, initProviderRepo, type UpstreamRecord } from '@floway-dev/provider';
import { noopUpstreamCallOptions, readJsonRequest, stubProviderModel } from '@floway-dev/test-utils';

const farFutureMs = Date.now() + 24 * 60 * 60 * 1000;

const freshAccessToken: CodexAccessTokenEntry = { token: 'at', expiresAt: farFutureMs, refreshedAt: 'now' };

const baseRecord: UpstreamRecord = {
  id: 'up_codex',
  kind: 'codex',
  name: 'Codex Plus',
  enabled: true,
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

const recordWithAccessToken = (entry: CodexAccessTokenEntry = freshAccessToken): UpstreamRecord => ({
  ...baseRecord,
  state: { accounts: [{ chatgptAccountId: 'acc', refresh_token: 'rt_v1', state: 'active', state_updated_at: '2026-01-01T00:00:00Z', openaiDeviceId: '11111111-2222-4333-8444-555555555555', accessToken: entry, quotaSnapshot: null }] },
});

const accessOnlyRecord = (entry: CodexAccessTokenEntry): UpstreamRecord => ({
  ...baseRecord,
  state: { accounts: [{ chatgptAccountId: 'acc', refresh_token: null, state: 'active', state_updated_at: '2026-01-01T00:00:00Z', openaiDeviceId: '11111111-2222-4333-8444-555555555555', accessToken: entry, quotaSnapshot: null }] },
});

let current: UpstreamRecord | null;
let repo: UpstreamStateRepoStub;

beforeEach(() => {
  current = recordWithAccessToken();
  repo = createUpstreamStateRepoStub(() => current, state => {
    current = { ...current!, state: state as CodexUpstreamState };
  });
  initProviderRepo(() => ({ upstreams: repo }));
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
    { slug: 'gpt-5.4', display_name: 'GPT-5.4', visibility: 'list', context_window: 272000, max_context_window: 1000000 },
    { slug: 'codex-auto-review', display_name: 'Codex Auto Review', visibility: 'hide', context_window: 272000, max_context_window: 1000000 },
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

describe('createCodexProvider', () => {
  test('owns request identity and turn metadata headers on the instance', () => {
    const provider = createCodexProvider(baseRecord);

    expect(provider.inboundHeaderAllowlist).toEqual([
      'originator',
      'session-id',
      'session_id',
      'thread-id',
      'x-client-request-id',
      'x-codex-image-turn-id',
      'x-codex-turn-metadata',
      'x-codex-window-id',
    ]);
  });

  test('returns an instance carrying provider kind and identity', async () => {
    const instance = createCodexProvider(baseRecord);
    expect(instance.kind).toBe('codex');
    expect(instance.upstreamId).toBe('up_codex');
    expect(instance.name).toBe('Codex Plus');
  });

  test('getProvidedModels uses the cached access token when fresh and surfaces every catalog entry', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(modelsResponse());
    const instance = createCodexProvider(baseRecord);
    const models = await instance.instance.getProvidedModels(directFetcher);
    // Provider surfaces both visible and hidden upstream models — operators
    // can dispatch to `codex-auto-review` even though ChatGPT's UI hides it.
    expect(models.map(m => m.id)).toEqual(['gpt-5.4', 'codex-auto-review', 'gpt-image-2']);
    expect(models[0].endpoints).toEqual({ responses: {} });
    expect(models[2]).toMatchObject({ kind: 'image', endpoints: { imagesGenerations: {}, imagesEdits: {} } });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toMatch(/\/codex\/models/);
  });

  test('getProvidedModels uses an unknown-expiry access-only token without an OAuth refresh', async () => {
    const record = accessOnlyRecord({ token: 'at_only', expiresAt: null, refreshedAt: 'now' });
    current = record;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(modelsResponse());
    const models = await createCodexProvider(record).instance.getProvidedModels(directFetcher);
    // Unknown plan fails open, so the provider-owned image model is surfaced too.
    expect(models.map(m => m.id)).toEqual(['gpt-5.4', 'codex-auto-review', 'gpt-image-2']);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers).get('authorization')).toBe('Bearer at_only');
  });

  test('getProvidedModels reports an expired access-only token before fetching', async () => {
    const record = accessOnlyRecord({ token: 'at_only', expiresAt: Date.now() - 1, refreshedAt: 'now' });
    current = record;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(createCodexProvider(record).instance.getProvidedModels(directFetcher)).rejects.toThrow(/expired.*re-import/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('getProvidedModels mints an access token when none is cached, then fetches the catalog', async () => {
    current = baseRecord;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input as Request).url);
      if (url.includes('/oauth/token')) return oauthTokenResponse();
      if (url.includes('/codex/models')) return modelsResponse();
      throw new Error(`unexpected fetch ${url}`);
    });
    const instance = createCodexProvider(baseRecord);
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
    const account = (current!.state as CodexUpstreamState).accounts[0];
    expect(account.refresh_token).toBe('rt_v2');
    expect(account.accessToken?.token).toBe('at_minted');
  });

  test('getProvidedModels propagates catalog fetch failures', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('upstream down', { status: 502 }));
    const instance = createCodexProvider(baseRecord);
    await expect(instance.instance.getProvidedModels(directFetcher)).rejects.toThrow(/Codex \/models fetch failed/);
  });

  test('getProvidedModels omits image models only for an explicit Free plan', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(modelsResponse());
    const freeRecord: UpstreamRecord = {
      ...baseRecord,
      config: { accounts: [{ email: 'a@b.com', chatgptAccountId: 'acc', chatgptUserId: 'usr', planType: 'free' }] },
    };
    const models = await createCodexProvider(freeRecord).instance.getProvidedModels(directFetcher);
    expect(models.map(model => model.id)).toEqual(['gpt-5.4', 'codex-auto-review']);
  });

  test('getProvidedModels fails open for an unknown future plan', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(modelsResponse());
    const futureRecord: UpstreamRecord = {
      ...baseRecord,
      config: { accounts: [{ email: 'a@b.com', chatgptAccountId: 'acc', chatgptUserId: 'usr', planType: 'future-plan' }] },
    };
    const models = await createCodexProvider(futureRecord).instance.getProvidedModels(directFetcher);
    expect(models.map(model => model.id)).toContain('gpt-image-2');
  });

  test('getProvidedModels uses the refreshed access-token plan over import-time config', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => modelsResponse());
    current = recordWithAccessToken({ ...freshAccessToken, planType: 'free' });
    const downgraded = await createCodexProvider(baseRecord).instance.getProvidedModels(directFetcher);
    expect(downgraded.map(model => model.id)).not.toContain('gpt-image-2');

    const importedFree: UpstreamRecord = {
      ...baseRecord,
      config: { accounts: [{ email: 'a@b.com', chatgptAccountId: 'acc', chatgptUserId: 'usr', planType: 'free' }] },
    };
    current = recordWithAccessToken({ ...freshAccessToken, planType: 'plus' });
    const upgraded = await createCodexProvider(importedFree).instance.getProvidedModels(directFetcher);
    expect(upgraded.map(model => model.id)).toContain('gpt-image-2');
  });

  test('getProvidedModels propagates OAuth refresh failures', async () => {
    current = baseRecord;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input as Request).url);
      if (url.includes('/oauth/token')) return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400, headers: new Headers({ 'content-type': 'application/json' }) });
      throw new Error(`unexpected fetch ${url}`);
    });
    const instance = createCodexProvider(baseRecord);
    await expect(instance.instance.getProvidedModels(directFetcher)).rejects.toThrow(/Codex OAuth session terminated/);
  });

  test('getProvidedModels resolves operator flag overrides into every ProviderModel', async () => {
    // Provider defaults and operator overrides are resolved once, then
    // threaded through every model. A previous regression hardcoded
    // `enabledFlags: new Set()` in the catalog mapper, dropping the resolved
    // set on the floor — this test guards against that.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(modelsResponse());
    const recordWithOverride: UpstreamRecord = {
      ...baseRecord,
      flagOverrides: { 'responses-web-search-shim': true },
    };
    const instance = createCodexProvider(recordWithOverride);
    const models = await instance.instance.getProvidedModels(directFetcher);
    for (const m of models) {
      expect(m.enabledFlags.has('rewrite-system-to-developer')).toBe(true);
      expect(m.enabledFlags.has('responses-web-search-shim')).toBe(true);
    }
  });

  test('callResponses preserves developer messages on the Codex wire', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    const instance = createCodexProvider(baseRecord);
    const result = await instance.instance.callResponses(
      stubProviderModel({ id: 'gpt-5.4', display_name: 'gpt-5.4', endpoints: { responses: {} } }),
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
    if (init === undefined) throw new Error('expected a Codex upstream request');
    const body = await readJsonRequest(init) as Record<string, unknown>;
    expect(body.instructions).toBe("You're a helpful assistant.");
    expect(body.input).toEqual([
      { type: 'message', role: 'developer', content: 'base instructions' },
      { type: 'message', role: 'user', content: 'hi' },
      { type: 'message', role: 'developer', content: 'inline instructions' },
    ]);
  });

  test('callResponses re-reads state per request (operator re-import takes effect)', async () => {
    repo.getById.mockResolvedValueOnce({ ...baseRecord, state: { accounts: [{ chatgptAccountId: 'acc', refresh_token: 'rt_v1', state: 'session_terminated', state_updated_at: '2026-01-02T00:00:00Z', openaiDeviceId: '11111111-2222-4333-8444-555555555555', accessToken: null, quotaSnapshot: null }] } as CodexUpstreamState });
    const instance = createCodexProvider(baseRecord);
    const result = await instance.instance.callResponses(
      stubProviderModel({ id: 'gpt-5.4', display_name: 'gpt-5.4', endpoints: { responses: {} } }),
      { input: [], stream: true },
      'generate',
      undefined,
      noopUpstreamCallOptions(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(503);
  });

  test('callImagesGenerations posts gpt-image-2 through the ChatGPT Codex endpoint', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      created: 1,
      data: [{ b64_json: 'aW1hZ2U=' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const instance = createCodexProvider(baseRecord);
    const model = stubProviderModel({ id: 'gpt-image-2', display_name: 'GPT-Image-2', kind: 'image', endpoints: { imagesGenerations: {}, imagesEdits: {} } });
    const options = noopUpstreamCallOptions();
    options.headers.set('x-codex-image-turn-id', 'turn-image');
    const result = await instance.instance.callImagesGenerations(model, { prompt: 'an orange circle', quality: 'low' }, undefined, options);
    expect(result.response.status).toBe(200);
    expect(result.modelKey).toBe('gpt-image-2');
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://chatgpt.com/backend-api/codex/images/generations');
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get('authorization')).toBe('Bearer at');
    expect(headers.get('chatgpt-account-id')).toBe('acc');
    expect(headers.get('x-codex-image-turn-id')).toBe('turn-image');
    expect(await readJsonRequest(init as RequestInit)).toEqual({ prompt: 'an orange circle', quality: 'low', model: 'gpt-image-2' });
  });

  test('callImagesGenerations rejects an explicit Free plan without touching upstream', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const freeRecord: UpstreamRecord = {
      ...baseRecord,
      config: { accounts: [{ email: 'a@b.com', chatgptAccountId: 'acc', chatgptUserId: 'usr', planType: 'free' }] },
    };
    const instance = createCodexProvider(freeRecord);
    const model = stubProviderModel({ id: 'gpt-image-2', display_name: 'GPT-Image-2', kind: 'image', endpoints: { imagesGenerations: {}, imagesEdits: {} } });
    const result = await instance.instance.callImagesGenerations(model, { prompt: 'an orange circle' }, undefined, noopUpstreamCallOptions());
    expect(result.response.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('callImagesEdits returns an operation-neutral error for an explicit Free plan', async () => {
    const freeRecord: UpstreamRecord = {
      ...baseRecord,
      config: { accounts: [{ email: 'a@b.com', chatgptAccountId: 'acc', chatgptUserId: 'usr', planType: 'free' }] },
    };
    const instance = createCodexProvider(freeRecord);
    const model = stubProviderModel({ id: 'gpt-image-2', display_name: 'GPT-Image-2', kind: 'image', endpoints: { imagesGenerations: {}, imagesEdits: {} } });
    const result = await instance.instance.callImagesEdits(model, {
      images: [{ type: 'reference', reference: { image_url: 'https://example.test/image.png' } }],
      parameters: { prompt: 'edit' },
    }, undefined, noopUpstreamCallOptions());
    expect(result.response.status).toBe(403);
    expect(await result.response.json()).toEqual({
      error: { type: 'image_tools_unavailable', message: 'ChatGPT Free accounts do not provide Codex image tools.' },
    });
  });

  test('callImagesEdits sends uploads as JSON data URLs to the ChatGPT Codex endpoint', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      created: 1,
      data: [{ b64_json: 'ZWRpdA==' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const instance = createCodexProvider(baseRecord);
    const model = stubProviderModel({ id: 'gpt-image-2', display_name: 'GPT-Image-2', kind: 'image', endpoints: { imagesGenerations: {}, imagesEdits: {} } });
    const options = noopUpstreamCallOptions();
    options.headers.set('originator', 'chatgpt_cca');
    const result = await instance.instance.callImagesEdits(model, {
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

  test.each([
    'callEmbeddings',
    'callAudioTranscriptions',
    'callChatCompletions',
    'callMessagesCountTokens',
    'callMessages',
  ] as const)('%s returns a synthetic 405 (data plane never dispatches these to Codex)', async method => {
    const instance = createCodexProvider(baseRecord);
    const model = stubProviderModel({ id: 'gpt-5.4', display_name: 'gpt-5.4', endpoints: { responses: {} } });
    // @ts-expect-error: each method has a different body type; we only assert
    // the synthetic 405 envelope is what comes back.
    const result = await instance.instance[method](model, {}, undefined, noopUpstreamCallOptions()) as { response: Response };
    expect(result.response.status).toBe(405);
    const body = await result.response.json() as { error: { type: string; message: string } };
    expect(body.error.type).toBe('method_not_allowed');
    expect(body.error.message).toMatch(/codex/i);
  });
});
