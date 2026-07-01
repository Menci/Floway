import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createCodexProvider } from './provider.ts';
import type { CodexAccessTokenEntry, CodexUpstreamState } from './state.ts';
import { directFetcher, initProviderRepo, type UpstreamRecord } from '@floway-dev/provider';
import { noopUpstreamCallOptions, stubProviderModel } from '@floway-dev/test-utils';

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
};

const recordWithAccessToken = (entry: CodexAccessTokenEntry = freshAccessToken): UpstreamRecord => ({
  ...baseRecord,
  state: { accounts: [{ chatgptAccountId: 'acc', refresh_token: 'rt_v1', state: 'active', state_updated_at: '2026-01-01T00:00:00Z', openaiDeviceId: '11111111-2222-4333-8444-555555555555', accessToken: entry, quotaSnapshot: null }] },
});

let saveStateSpy: ReturnType<typeof vi.fn<(id: string, newState: unknown, options: { expectedState: unknown }) => Promise<{ updated: boolean }>>>;
let getByIdSpy: ReturnType<typeof vi.fn<(id: string) => Promise<UpstreamRecord | null>>>;

beforeEach(() => {
  saveStateSpy = vi.fn<(id: string, newState: unknown, options: { expectedState: unknown }) => Promise<{ updated: boolean }>>(async () => ({ updated: true }));
  getByIdSpy = vi.fn<(id: string) => Promise<UpstreamRecord | null>>(async () => recordWithAccessToken());
  initProviderRepo(() => ({
    upstreams: { getById: getByIdSpy, saveState: saveStateSpy },
  }));
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

const oauthTokenResponse = (overrides: Partial<{ access_token: string; refresh_token: string; expires_in: number }> = {}): Response => new Response(JSON.stringify({
  access_token: overrides.access_token ?? 'at_minted',
  refresh_token: overrides.refresh_token ?? 'rt_v2',
  id_token: 'id_token_v2',
  expires_in: overrides.expires_in ?? 3600,
}), { status: 200, headers: new Headers({ 'content-type': 'application/json' }) });

describe('createCodexProvider', () => {
  test('returns an instance carrying provider kind and identity', async () => {
    const instance = await createCodexProvider(baseRecord);
    expect(instance.kind).toBe('codex');
    expect(instance.upstream).toBe('up_codex');
    expect(instance.name).toBe('Codex Plus');
    expect(instance.supportsResponsesItemReference).toBe(false);
  });

  test('getProvidedModels uses the cached access token when fresh and surfaces every catalog entry', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(modelsResponse());
    const instance = await createCodexProvider(baseRecord);
    const models = await instance.instance.getProvidedModels(directFetcher);
    // Provider surfaces both visible and hidden upstream models — operators
    // can dispatch to `codex-auto-review` even though ChatGPT's UI hides it.
    expect(models.map(m => m.id)).toEqual(['gpt-5.4', 'codex-auto-review']);
    expect(models[0].endpoints).toEqual({ responses: {} });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toMatch(/\/codex\/models/);
  });

  test('getProvidedModels mints an access token when none is cached, then fetches the catalog', async () => {
    getByIdSpy.mockImplementation(async () => baseRecord);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input as Request).url);
      if (url.includes('/oauth/token')) return oauthTokenResponse();
      if (url.includes('/codex/models')) return modelsResponse();
      throw new Error(`unexpected fetch ${url}`);
    });
    const instance = await createCodexProvider(baseRecord);
    const models = await instance.instance.getProvidedModels(directFetcher);
    expect(models.map(m => m.id)).toEqual(['gpt-5.4', 'codex-auto-review']);
    const urls = fetchSpy.mock.calls.map(c => typeof c[0] === 'string' ? c[0] : (c[0] as URL | Request).toString());
    expect(urls.some(u => u.includes('/oauth/token'))).toBe(true);
    expect(urls.some(u => u.includes('/codex/models'))).toBe(true);
    // Mint persists twice via CAS: once for the rotated refresh_token from the
    // OAuth response, once for the freshly minted access token in the same
    // account slot. Both writes must land for the next caller to see a usable
    // credential pair.
    const persistedStates = saveStateSpy.mock.calls.map(c => c[1] as CodexUpstreamState);
    expect(persistedStates.some(s => s.accounts[0].refresh_token === 'rt_v2')).toBe(true);
    expect(persistedStates.some(s => s.accounts[0].accessToken?.token === 'at_minted')).toBe(true);
  });

  test('getProvidedModels propagates catalog fetch failures', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('upstream down', { status: 502 }));
    const instance = await createCodexProvider(baseRecord);
    await expect(instance.instance.getProvidedModels(directFetcher)).rejects.toThrow(/Codex \/models fetch failed/);
  });

  test('getProvidedModels propagates OAuth refresh failures', async () => {
    getByIdSpy.mockImplementation(async () => baseRecord);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input as Request).url);
      if (url.includes('/oauth/token')) return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400, headers: new Headers({ 'content-type': 'application/json' }) });
      throw new Error(`unexpected fetch ${url}`);
    });
    const instance = await createCodexProvider(baseRecord);
    await expect(instance.instance.getProvidedModels(directFetcher)).rejects.toThrow(/Codex OAuth session terminated/);
  });

  test('getProvidedModels resolves operator flag overrides into every ProviderModel', async () => {
    // The codex provider has no provider-default flags, so an operator
    // toggling `responses-web-search-shim` on at the upstream layer is the
    // only signal downstream interceptors get. A previous regression
    // hardcoded `enabledFlags: new Set()` in the catalog mapper, dropping
    // the override on the floor — this test guards against that.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(modelsResponse());
    const recordWithOverride: UpstreamRecord = {
      ...baseRecord,
      flagOverrides: { 'responses-web-search-shim': true },
    };
    const instance = await createCodexProvider(recordWithOverride);
    const models = await instance.instance.getProvidedModels(directFetcher);
    for (const m of models) {
      expect(m.enabledFlags.has('responses-web-search-shim')).toBe(true);
    }
  });

  test('callResponses round-trips through fetch transport', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    const instance = await createCodexProvider(baseRecord);
    const result = await instance.instance.callResponses(
      stubProviderModel({ id: 'gpt-5.4', display_name: 'gpt-5.4', endpoints: { responses: {} } }),
      { input: [{ type: 'message', role: 'user', content: 'hi' }], stream: true },
      'generate',
      undefined,
      noopUpstreamCallOptions(),
    );
    expect(result.ok).toBe(true);
    expect(result.action).toBe('generate');
  });

  test('callResponses re-reads state per request (operator re-import takes effect)', async () => {
    getByIdSpy.mockResolvedValueOnce({ ...baseRecord, state: { accounts: [{ chatgptAccountId: 'acc', refresh_token: 'rt_v1', state: 'session_terminated', state_updated_at: '2026-01-02T00:00:00Z', openaiDeviceId: '11111111-2222-4333-8444-555555555555', accessToken: null, quotaSnapshot: null }] } as CodexUpstreamState });
    const instance = await createCodexProvider(baseRecord);
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

  test.each([
    'callEmbeddings',
    'callImagesGenerations',
    'callImagesEdits',
    'callChatCompletions',
    'callMessagesCountTokens',
    'callMessages',
  ] as const)('%s returns a synthetic 405 (data plane never dispatches these to Codex)', async method => {
    const instance = await createCodexProvider(baseRecord);
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
