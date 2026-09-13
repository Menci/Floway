import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createUpstreamStateRepoStub, type UpstreamStateRepoStub } from './upstream-state-repo.ts';
import { createCodexProvider } from '../src/provider.ts';
import type { CodexAccessTokenEntry, CodexUpstreamState } from '../src/state.ts';
import { OPENAI_RESPONSES_LITE_HEADER, type CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
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

test.each(['standard', 'lite', 'compact', 'search'] as const)('upstream device policy reaches %s and keeps client conversations independent', async transport => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => transport === 'compact'
    ? Response.json({ id: 'cmp', object: 'response.compaction', output: [] })
    : sseResponse());
  for (const enabled of [undefined, false, true]) {
    for (const [accountId, deviceId, clientId] of [['acc', 'device-a', 'client-1'], ['acc', 'device-a', 'client-2'], ['other', 'device-b', 'client-1']]) {
      const account = { ...(recordWithAccessToken().state as CodexUpstreamState).accounts[0], chatgptAccountId: accountId, openaiDeviceId: deviceId };
      current = {
        ...recordWithAccessToken(),
        config: {
          accounts: [{ email: 'a@b.com', chatgptAccountId: accountId, chatgptUserId: 'usr', planType: 'plus' }],
          ...(enabled !== undefined ? { normalizeInstallationId: enabled } : {}),
        },
        state: { accounts: [account] },
      };
      const instance = createCodexProvider(current).instance;
      const metadata = {
        installation_id: clientId, session_id: `session-${clientId}`, thread_id: `thread-${clientId}`,
        turn_id: `turn-${clientId}`, window_id: `thread-${clientId}:3`, parent_thread_id: 'parent',
        workspaces: { '/home/user/project': { remotes: ['https://example.com/repo'] } },
      };
      const body = {
        input: [], prompt_cache_key: `cache-${clientId}`,
        client_metadata: {
          'x-codex-installation-id': clientId,
          'x-codex-turn-metadata': JSON.stringify(metadata),
          custom: 'retained',
        },
      };
      const original = structuredClone(body);
      const headers = new Headers({ 'x-codex-turn-metadata': JSON.stringify(metadata) });
      if (transport === 'lite') headers.set(OPENAI_RESPONSES_LITE_HEADER, 'true');
      const options = { ...noopUpstreamCallOptions(), headers };
      if (transport === 'search') {
        await instance.callAlphaSearch!(stubProviderModel(), body, undefined, options);
      } else {
        const result = await instance.callOpenAIResponses(stubProviderModel(), body, transport === 'compact' ? 'compact' : 'generate', undefined, options);
        expect(result.ok).toBe(true);
      }
      const [, init] = fetchSpy.mock.calls.at(-1)!;
      const outboundHeaders = new Headers(init?.headers);
      const turn = JSON.parse(outboundHeaders.get('x-codex-turn-metadata')!) as Record<string, unknown>;
      const expectedId = enabled === true ? deviceId : clientId;
      expect(turn).toMatchObject({ ...metadata, installation_id: expectedId });
      expect(outboundHeaders.get('chatgpt-account-id')).toBe(accountId);
      const outbound = await readJsonRequest(init as RequestInit) as Record<string, unknown>;
      if (transport !== 'compact') {
        const client = outbound.client_metadata as Record<string, unknown>;
        expect(client['x-codex-installation-id']).toBe(expectedId);
        expect(JSON.parse(client['x-codex-turn-metadata'] as string)).toMatchObject({ ...metadata, installation_id: expectedId });
        expect(client.custom).toBe('retained');
        expect(outbound.prompt_cache_key).toBe(`cache-${clientId}`);
      }
      expect(body).toEqual(original);
      expect((current!.state as CodexUpstreamState).accounts[0].openaiDeviceId).toBe(deviceId);
    }
  }
});

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
    expect(models[0].endpoints).toEqual({ openaiResponses: {} });
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

  test('discovers Astra behind its upstream minimum client version without changing standard Responses models', async () => {
    // The released catalog gates Astra at 0.153.0 and selects Lite with
    // model metadata, independently of its slug and reasoning levels.
    // https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/models-manager/models.json
    const astra = {
      slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', context_window: 272000,
      input_modalities: ['text', 'image'], use_responses_lite: true,
      supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(effort => ({ effort, description: '' })),
      default_reasoning_level: 'low', multi_agent_reasoning_effort: 'xhigh',
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = new URL(String(input));
      const version = url.searchParams.get('client_version') ?? '0.0.0';
      const models = [
        { slug: 'gpt-5.4', display_name: 'GPT-5.4', context_window: 272000, use_responses_lite: false },
        ...(version.localeCompare('0.153.0', undefined, { numeric: true }) >= 0 ? [astra] : []),
      ];
      return new Response(JSON.stringify({ models }), { headers: { 'content-type': 'application/json' } });
    });

    const models = await createCodexProvider(baseRecord).instance.getProvidedModels(directFetcher);
    const astraModel = models.find(model => model.id === astra.slug);
    expect(astraModel).toMatchObject({
      endpoints: { openaiResponses: { transport: 'lite' } },
      limits: { max_context_window_tokens: 272000 },
      chat: {
        modalities: { input: ['text', 'image'], output: ['text'] },
        reasoning: { effort: { supported: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'low' } },
      },
    });
    expect(models.find(model => model.id === 'gpt-5.4')?.endpoints).toEqual({ openaiResponses: {} });
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
      flagOverrides: { 'openai-responses-web-search-shim': true },
    };
    const instance = createCodexProvider(recordWithOverride);
    const models = await instance.instance.getProvidedModels(directFetcher);
    for (const m of models) {
      expect(m.enabledFlags.has('rewrite-system-to-developer')).toBe(true);
      expect(m.enabledFlags.has('openai-responses-web-search-shim')).toBe(true);
    }
  });

  test('callOpenAIResponses preserves developer messages on the Codex wire', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    const instance = createCodexProvider(baseRecord);
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
    if (init === undefined) throw new Error('expected a Codex upstream request');
    const body = await readJsonRequest(init) as Record<string, unknown>;
    expect(body.instructions).toBe("You're a helpful assistant.");
    expect(body.input).toEqual([
      { type: 'message', role: 'developer', content: 'base instructions' },
      { type: 'message', role: 'user', content: 'hi' },
      { type: 'message', role: 'developer', content: 'inline instructions' },
    ]);
  });

  test.each((['generate', 'compact'] as const).flatMap(action => ['ultra', 'persistent', 'future_effort'].map(effort => ({ action, effort }))))('native Lite $action keeps instructions in input and explicit $effort unchanged', async ({ action, effort }) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(action === 'generate'
      ? sseResponse()
      : new Response(JSON.stringify({ id: 'cmp_result', object: 'response.compaction', output: [] }), { headers: { 'content-type': 'application/json' } }));
    const input: CanonicalOpenAIResponsesPayload['input'] = [
      { type: 'additional_tools', role: 'developer', id: 'at_client', tools: [{ type: 'function', name: 'lookup', async: true }] },
      { type: 'message', role: 'developer', id: 'msg_client', content: 'Native instructions.' },
      { type: 'message', role: 'user', content: 'Hello.' },
      { type: 'configuration_update', reasoning: { effort } },
    ];
    const opts = noopUpstreamCallOptions();
    opts.headers.set(OPENAI_RESPONSES_LITE_HEADER, 'true');
    const result = await createCodexProvider(baseRecord).instance.callOpenAIResponses(
      stubProviderModel({ id: 'gpt-6-astra', endpoints: { openaiResponses: { transport: 'lite' } } }),
      { input, reasoning: { effort, context: 'all_turns' }, parallel_tool_calls: false, access_programs: { cyber: 'future_program' } },
      action, undefined, opts,
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.action === 'generate') for await (const _frame of result.events) { /* Drain the upstream stream. */ }
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://chatgpt.com/backend-api/codex/responses${action === 'compact' ? '/compact' : ''}`);
    expect(new Headers(init.headers).get(OPENAI_RESPONSES_LITE_HEADER)).toBe('true');
    const body = await readJsonRequest(init) as Record<string, unknown>;
    expect(body.input).toEqual(input);
    expect(body).not.toHaveProperty('instructions');
    expect(body).not.toHaveProperty('tools');
    expect(body.reasoning).toEqual({ effort, context: 'all_turns' });
    expect(body.parallel_tool_calls).toBe(false);
    expect(body.access_programs).toEqual({ cyber: 'future_program' });
  });

  test.each(['standard', 'lite'] as const)('forwards current Codex stream options on the %s wire', async transport => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    const opts = noopUpstreamCallOptions();
    if (transport === 'lite') opts.headers.set(OPENAI_RESPONSES_LITE_HEADER, 'true');
    const payload = {
      input: [], stream_options: { reasoning_summary_delivery: 'sequential_cutoff', include_obfuscation: false },
    };
    const result = await createCodexProvider(baseRecord).instance.callOpenAIResponses(
      stubProviderModel({ id: 'gpt-6-astra', endpoints: { openaiResponses: { transport } } }),
      payload, 'generate', undefined, opts,
    );
    if (result.ok && result.action === 'generate') for await (const _frame of result.events) { /* Drain the upstream stream. */ }
    const body = await readJsonRequest(fetchSpy.mock.calls[0][1] as RequestInit) as Record<string, unknown>;
    expect(body.stream_options).toEqual(payload.stream_options);
  });

  test('callOpenAIResponses re-reads state per request (operator re-import takes effect)', async () => {
    repo.getById.mockResolvedValueOnce({ ...baseRecord, state: { accounts: [{ chatgptAccountId: 'acc', refresh_token: 'rt_v1', state: 'session_terminated', state_updated_at: '2026-01-02T00:00:00Z', openaiDeviceId: '11111111-2222-4333-8444-555555555555', accessToken: null, quotaSnapshot: null }] } as CodexUpstreamState });
    const instance = createCodexProvider(baseRecord);
    const result = await instance.instance.callOpenAIResponses(
      stubProviderModel({ id: 'gpt-5.4', display_name: 'gpt-5.4', endpoints: { openaiResponses: {} } }),
      { input: [], stream: true },
      'generate',
      undefined,
      noopUpstreamCallOptions(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(503);
  });

  test('callOpenAIImagesGenerations posts gpt-image-2 through the ChatGPT Codex endpoint', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      created: 1,
      data: [{ b64_json: 'aW1hZ2U=' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const instance = createCodexProvider(baseRecord);
    const model = stubProviderModel({ id: 'gpt-image-2', display_name: 'GPT-Image-2', kind: 'image', endpoints: { openaiImagesGenerations: {}, openaiImagesEdits: {} } });
    const options = noopUpstreamCallOptions();
    options.headers.set('x-codex-image-turn-id', 'turn-image');
    const result = await instance.instance.callOpenAIImagesGenerations(model, { prompt: 'an orange circle', quality: 'low' }, undefined, options);
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

  test('callOpenAIImagesGenerations rejects an explicit Free plan without touching upstream', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const freeRecord: UpstreamRecord = {
      ...baseRecord,
      config: { accounts: [{ email: 'a@b.com', chatgptAccountId: 'acc', chatgptUserId: 'usr', planType: 'free' }] },
    };
    const instance = createCodexProvider(freeRecord);
    const model = stubProviderModel({ id: 'gpt-image-2', display_name: 'GPT-Image-2', kind: 'image', endpoints: { openaiImagesGenerations: {}, openaiImagesEdits: {} } });
    const result = await instance.instance.callOpenAIImagesGenerations(model, { prompt: 'an orange circle' }, undefined, noopUpstreamCallOptions());
    expect(result.response.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('callOpenAIImagesEdits returns an operation-neutral error for an explicit Free plan', async () => {
    const freeRecord: UpstreamRecord = {
      ...baseRecord,
      config: { accounts: [{ email: 'a@b.com', chatgptAccountId: 'acc', chatgptUserId: 'usr', planType: 'free' }] },
    };
    const instance = createCodexProvider(freeRecord);
    const model = stubProviderModel({ id: 'gpt-image-2', display_name: 'GPT-Image-2', kind: 'image', endpoints: { openaiImagesGenerations: {}, openaiImagesEdits: {} } });
    const result = await instance.instance.callOpenAIImagesEdits(model, {
      images: [{ type: 'reference', reference: { image_url: 'https://example.test/image.png' } }],
      parameters: { prompt: 'edit' },
    }, undefined, noopUpstreamCallOptions());
    expect(result.response.status).toBe(403);
    expect(await result.response.json()).toEqual({
      error: { type: 'image_tools_unavailable', message: 'ChatGPT Free accounts do not provide Codex image tools.' },
    });
  });

  test('callOpenAIImagesEdits sends uploads as JSON data URLs to the ChatGPT Codex endpoint', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      created: 1,
      data: [{ b64_json: 'ZWRpdA==' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const instance = createCodexProvider(baseRecord);
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

  test.each([
    'callOpenAIEmbeddings',
    'callOpenAIAudioTranscriptions',
    'callOpenAIChatCompletions',
    'callAnthropicMessagesCountTokens',
    'callAnthropicMessages',
  ] as const)('%s returns a synthetic 405 (data plane never dispatches these to Codex)', async method => {
    const instance = createCodexProvider(baseRecord);
    const model = stubProviderModel({ id: 'gpt-5.4', display_name: 'gpt-5.4', endpoints: { openaiResponses: {} } });
    // @ts-expect-error: each method has a different body type; we only assert
    // the synthetic 405 envelope is what comes back.
    const result = await instance.instance[method](model, {}, undefined, noopUpstreamCallOptions()) as { response: Response };
    expect(result.response.status).toBe(405);
    const body = await result.response.json() as { error: { type: string; message: string } };
    expect(body.error.type).toBe('method_not_allowed');
    expect(body.error.message).toMatch(/codex/i);
  });
});
