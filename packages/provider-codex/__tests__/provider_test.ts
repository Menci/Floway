import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createUpstreamStateRepoStub, type UpstreamStateRepoStub } from './upstream-state-repo.ts';
import { CODEX_RESPONSES_LITE_CLIENT_METADATA_KEY, CODEX_RESPONSES_LITE_HEADER } from '../src/constants.ts';
import { createCodexProvider } from '../src/provider.ts';
import type { CodexAccessTokenEntry, CodexUpstreamState } from '../src/state.ts';
import { exchangeResponse } from '@floway-dev/http/pipeline';
import { getFailureFacts, move, run, setRelease, type Event } from '@floway-dev/pipeline';
import { directFetcher, initProviderRepo, providerModelFacts, type ProviderOperationPayloads, type UpstreamRecord } from '@floway-dev/provider';
import { callProviderPipeline, collectChatProviderPipeline, noopUpstreamCallOptions, readJsonRequest, stubProviderModel } from '@floway-dev/test-utils';

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

const oauthTokenResponse = (overrides: Partial<{ access_token: string; refresh_token: string; expires_in: number; id_token: string }> = {}): Response => new Response(JSON.stringify({
  access_token: overrides.access_token ?? 'at_minted',
  refresh_token: overrides.refresh_token ?? 'rt_v2',
  id_token: overrides.id_token ?? idToken(),
  expires_in: overrides.expires_in ?? 3600,
}), { status: 200, headers: new Headers({ 'content-type': 'application/json' }) });

describe('createCodexProvider', () => {
  test('the401 finite observer preserves an original stream failure without canceling its locked body', async () => {
    const original = new Error('Codex refusal body broke');
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(original); } });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status: 401 }));
    const events: Event[] = [];
    const caught = await collectChatProviderPipeline(createCodexProvider(current!), 'openaiResponses', stubProviderModel({ id: 'gpt-5.4', endpoints: { openaiResponses: {} } }), { input: [] }, undefined, noopUpstreamCallOptions(), { dump: event => { events.push(event); } }).catch((error: unknown) => error);
    expect(caught).toBe(original);
    expect(getFailureFacts(caught)).toMatchObject({ 'response.provider.called': true, 'response.provider.modelKey': 'gpt-5.4' });
    expect(events.find(event => event.type === 'stage.failed')).toMatchObject({ error: original });
  });

  test('access-only401 remains readable while terminal persistence failure reaches the run outcome', async () => {
    current = accessOnlyRecord(freshAccessToken);
    const writeError = new Error('terminal state write failed');
    repo.saveState.mockRejectedValue(writeError);
    const body = { error: { code: 'token_invalidated', message: 're-import required' }, diagnostic: 'full upstream details' };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(body, { status: 401, headers: { 'x-upstream': 'retained' } }));
    const provider = createCodexProvider(current);
    const events: Event[] = [];
    const executed = await run(provider.pipelines.openaiResponses!, move({
      'request.provider.model': providerModelFacts(stubProviderModel({ id: 'gpt-5.4', endpoints: { openaiResponses: {} } })),
      'request.provider.payload': { input: [], stream: true },
      'request.http.callId': 0, 'request.http.headers': [],
    }), { httpCall: () => noopUpstreamCallOptions(), recordProtocolFrames: <T>(frames: AsyncIterable<T>) => frames, dump: (event: Event) => { events.push(event); } });
    const exchange = executed.facts['response.http.exchange'];
    if (exchange.type === 'transportFailure') throw exchange.error;
    const response = exchangeResponse(exchange);
    expect(response.status).toBe(401);
    expect(response.headers.get('x-upstream')).toBe('retained');
    expect(await response.json()).toEqual(body);
    if (exchange.body !== null) setRelease(exchange.body, async () => {});
    await expect(executed.drain()).rejects.toBe(writeError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(events.find(event => event.type === 'deferred.settled' && event.outcome.status === 'rejected')).toMatchObject({
      deferred: (executed.facts as typeof executed.facts & Record<string, unknown>)['response.codex.background'], outcome: { status: 'rejected', reason: writeError },
    });
  });

  test.each(['openaiResponses', 'openaiResponsesCompact'] as const)('%s pipeline keeps parsed private wire content and actual endpoint observations', async operation => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => operation === 'openaiResponses'
      ? new Response(sseResponse().body, { headers: { [CODEX_RESPONSES_LITE_HEADER]: 'true' } })
      : Response.json({ id: 'compact', object: 'response.compaction', output: [] }));
    const provider = createCodexProvider(current!);
    const model = stubProviderModel({ id: 'future-lite', endpoints: { openaiResponses: {} }, providerData: { useResponsesLite: true } });
    const options = noopUpstreamCallOptions();
    const result = await collectChatProviderPipeline(provider, operation, model, {
      input: [{ type: 'message', role: 'user', content: 'hi' }], tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }], text: { verbosity: 'low' },
    }, undefined, options);
    const wire = await readJsonRequest(fetchSpy.mock.calls[0]![1] as RequestInit) as Record<string, unknown>;
    expect(wire).not.toHaveProperty('instructions');
    expect(wire).not.toHaveProperty('tools');
    expect(wire.text).toEqual({ verbosity: 'low' });
    expect(typeof result.facts['request.http.body']).toBe('object');
    expect(result.facts['response.provider.called']).toBe(true);
    expect(result.facts['response.provider.modelKey']).toBe('future-lite');
    const output = result.facts['response.provider.output'];
    if (output === null || !('kind' in output)) throw new Error('Expected protocol output');
    if (output.kind === 'stream') {
      expect(result.frames.filter(frame => frame.type === 'event').map(frame => frame.event.type)).toEqual(['response.created', 'response.in_progress', 'response.completed']);
      const exchange = result.facts['response.http.exchange'];
      if (exchange.type !== 'response') throw new Error('Expected response');
      expect(exchange.headers.some(([name]) => name === CODEX_RESPONSES_LITE_HEADER)).toBe(false);
      expect(exchange.headers).toContainEqual(['content-type', 'text/event-stream']);
    } else expect(output.body).toMatchObject({ object: 'response.compaction' });
  });

  test('Responses pipeline retains the first 401 observation and retries without applying the image plan gate', async () => {
    const state = current!.state as CodexUpstreamState;
    current = { ...current!, config: { accounts: [{ email: 'a@b.com', chatgptAccountId: 'acc', chatgptUserId: 'usr', planType: 'free' }] }, state: { accounts: [{ ...state.accounts[0]!, accessToken: { ...freshAccessToken, planType: 'free' } }] } };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input) === 'https://auth.openai.com/oauth/token') return oauthTokenResponse({ id_token: idToken('free') });
      return new Headers(init?.headers).get('authorization') === 'Bearer at'
        ? Response.json({ error: { code: 'invalid_token', message: 'expired' } }, { status: 401 })
        : sseResponse();
    });
    const provider = createCodexProvider(current!);
    const model = stubProviderModel({ id: 'gpt-5.4', endpoints: { openaiResponses: {} } });
    const options = noopUpstreamCallOptions();
    const result = await collectChatProviderPipeline(provider, 'openaiResponses', model, { input: [] }, undefined, options);
    expect(result.facts['response.provider.previousCalls']).toEqual([{ modelKey: 'gpt-5.4' }]);
    expect(fetchSpy.mock.calls.filter(([url]) => String(url).includes('/responses'))).toHaveLength(2);
    const output = result.facts['response.provider.output'];
    if (output === null || !('kind' in output) || output.kind !== 'stream') throw new Error('Expected stream');
    expect(result.frames.some(frame => frame.type === 'event' && frame.event.type === 'response.completed')).toBe(true);
  });

  test('Codex Images records the complete parsed 401 body and preserves its preceding endpoint observation', async () => {
    const refusal = { error: { code: 'invalid_token', message: 'expired bearer' }, diagnostic: 'x'.repeat(600) };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input) === 'https://auth.openai.com/oauth/token') return oauthTokenResponse();
      return new Headers(init?.headers).get('authorization') === 'Bearer at'
        ? Response.json(refusal, { status: 401 })
        : Response.json({ created: 1, data: [] });
    });
    const provider = createCodexProvider(current!);
    const model = stubProviderModel({ id: 'gpt-image-2', kind: 'image', endpoints: { openaiImagesGenerations: {}, openaiImagesEdits: {} } });
    const events: Event[] = [];
    const options = noopUpstreamCallOptions();
    const executed = await run(provider.pipelines.openaiImagesGenerations!, move({
      'request.provider.model': providerModelFacts(model),
      'request.provider.payload': { prompt: 'circle' },
      'request.http.callId': 0,
      'request.http.headers': [],
    }), { httpCall: () => ({ ...options, signal: undefined }), dump: (event: Event) => { events.push(event); } });
    expect(events.some(event => event.type === 'stage.leaved' && JSON.stringify(event.facts['response.codex.failureBody']) === JSON.stringify(refusal))).toBe(true);
    expect(executed.facts['response.provider.previousCalls']).toEqual([{ modelKey: 'gpt-image-2' }]);
    const exchange = executed.facts['response.http.exchange'];
    if (exchange.type !== 'response') throw new Error('expected final model reply');
    await exchangeResponse(exchange).arrayBuffer();
    if (exchange.body !== null) setRelease(exchange.body, async () => {});
    await executed.drain();
  });

  test('Codex Images pipeline preserves the image turn and payload across a renewable 401 retry', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input) === 'https://auth.openai.com/oauth/token') return oauthTokenResponse();
      const headers = new Headers(init?.headers);
      return headers.get('authorization') === 'Bearer at'
        ? new Response(JSON.stringify({ error: { code: 'invalid_token', message: 'expired bearer' } }), { status: 401 })
        : new Response(JSON.stringify({ created: 1, data: [{ b64_json: 'image' }] }), { status: 201, headers: { 'x-upstream': 'retained' } });
    });
    const provider = createCodexProvider(current!);
    const model = stubProviderModel({ id: 'gpt-image-2', kind: 'image', endpoints: { openaiImagesGenerations: {}, openaiImagesEdits: {} } });
    const options = noopUpstreamCallOptions();
    options.headers.set('x-codex-image-turn-id', 'stable-image-turn');
    const result = await callProviderPipeline(provider, 'openaiImagesGenerations', model, { prompt: 'blue circle' }, undefined, options);
    expect(result.called).toBe(true);
    expect(result.previousCalls).toEqual([{ modelKey: 'gpt-image-2' }]);
    expect(result.response.status).toBe(201);
    expect(result.response.headers.get('x-upstream')).toBe('retained');
    const imageCalls = fetchSpy.mock.calls.filter(([input]) => String(input).endsWith('/codex/images/generations'));
    expect(imageCalls).toHaveLength(2);
    expect(imageCalls.map(([, init]) => new Headers(init?.headers).get('x-codex-image-turn-id'))).toEqual(['stable-image-turn', 'stable-image-turn']);
    expect(await Promise.all(imageCalls.map(([, init]) => readJsonRequest(init!)))).toEqual([{ prompt: 'blue circle', model: 'gpt-image-2' }, { prompt: 'blue circle', model: 'gpt-image-2' }]);
  });

  test('Codex Images pipeline marks a preflight Free-plan refusal as an uncalled model endpoint', async () => {
    current = { ...current!, state: { accounts: [{ ...(current!.state as CodexUpstreamState).accounts[0], accessToken: { ...freshAccessToken, planType: 'free' } }] } };
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const provider = createCodexProvider(current);
    const model = stubProviderModel({ id: 'gpt-image-2', kind: 'image', endpoints: { openaiImagesGenerations: {}, openaiImagesEdits: {} } });
    const result = await callProviderPipeline(provider, 'openaiImagesGenerations', model, { prompt: 'blue circle' });
    expect(result.response.status).toBe(403);
    expect(result.called).toBe(false);
    expect(result.previousCalls).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

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
    expect(models[0].providerData).toEqual({ contextWindow: 272000, useResponsesLite: false });
    expect(models[1].providerData).toEqual({ contextWindow: 272000, useResponsesLite: true });
    expect(models[2]).toMatchObject({ kind: 'image', endpoints: { openaiImagesGenerations: {}, openaiImagesEdits: {} } });
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
    await expect(instance.instance.getProvidedModels(directFetcher)).rejects.toMatchObject({
      displayResponse: { status: 502, body: 'upstream down' },
    });
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
    const result = await collectChatProviderPipeline(instance, 'openaiResponses',
      stubProviderModel({ id: 'gpt-5.4', display_name: 'gpt-5.4', endpoints: { openaiResponses: {} } }),
      {
        input: [
          { type: 'message', role: 'developer', content: 'base instructions' },
          { type: 'message', role: 'user', content: 'hi' },
          { type: 'message', role: 'developer', content: 'inline instructions' },
        ],
        stream: true,
      },
      undefined,
      noopUpstreamCallOptions());
    expect(result.output).not.toBeNull();
    expect(result.facts['response.provider.responsesAction']).toBe('generate');
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

  test.each(['generate', 'compact'] as const)('%s retains the full Standard body through stages before private Lite encoding', async action => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => action === 'generate'
      ? sseResponse()
      : new Response(JSON.stringify({ id: 'cmp_1', object: 'response.compaction', output: [] })));
    const provider = createCodexProvider(baseRecord);
    const model = stubProviderModel({ id: 'future-lite', endpoints: { openaiResponses: {} }, providerData: { useResponsesLite: true } });
    const tool = { type: 'function' as const, name: 'lookup', parameters: { type: 'object' } };
    const input = [
      { type: 'additional_tools' as const, role: 'developer' as const, tools: [tool] },
      { type: 'message' as const, role: 'developer' as const, content: 'inline instructions' },
      { type: 'message' as const, role: 'user' as const, content: 'hello' },
    ];
    const options = noopUpstreamCallOptions();
    options.headers.set(CODEX_RESPONSES_LITE_HEADER, 'true');
    const result = await collectChatProviderPipeline(provider, action === 'generate' ? 'openaiResponses' : 'openaiResponsesCompact', model, {
      input,
      tools: [{ type: 'custom', name: 'patch' }],
      text: { verbosity: 'low' },
      client_metadata: { [CODEX_RESPONSES_LITE_CLIENT_METADATA_KEY]: 'true' },
    } as ProviderOperationPayloads['openaiResponses'], undefined, options);
    expect(result.output).not.toBeNull();
    expect(result.facts['response.provider.responsesAction']).toBe(action);
    const wire = await readJsonRequest(fetchSpy.mock.calls[0]![1] as RequestInit) as Record<string, unknown>;
    expect(wire).not.toHaveProperty('instructions');
    expect(wire).not.toHaveProperty('tools');
    expect(wire.text).toEqual({ verbosity: 'low' });
    expect(wire.input).toEqual([
      {
        type: 'additional_tools', role: 'developer', id: expect.stringMatching(/^at_/),
        tools: [{ type: 'namespace', name: 'functions', description: '', tools: [{ type: 'custom', name: 'patch' }, tool] }],
      },
      {
        type: 'message', role: 'developer', id: expect.stringMatching(/^msg_/),
        content: [{ type: 'input_text', text: "You're a helpful assistant." }],
        internal_chat_message_metadata_passthrough: { content_item_kinds: ['model.base_instructions'] },
      },
      ...input.slice(1),
    ]);
    expect(input).toHaveLength(3);
    expect(options.headers.get(CODEX_RESPONSES_LITE_HEADER)).toBe('true');
  });

  test('callOpenAIResponses re-reads state per request (operator re-import takes effect)', async () => {
    repo.getById.mockResolvedValueOnce({ ...baseRecord, state: { accounts: [{ chatgptAccountId: 'acc', refresh_token: 'rt_v1', state: 'session_terminated', state_updated_at: '2026-01-02T00:00:00Z', openaiDeviceId: '11111111-2222-4333-8444-555555555555', accessToken: null, quotaSnapshot: null }] } as CodexUpstreamState });
    const instance = createCodexProvider(baseRecord);
    const result = await collectChatProviderPipeline(instance, 'openaiResponses',
      stubProviderModel({ id: 'gpt-5.4', display_name: 'gpt-5.4', endpoints: { openaiResponses: {} } }),
      { input: [], stream: true },
      undefined,
      noopUpstreamCallOptions());
    expect(result.output).toBeNull();
    expect(result.response!.status).toBe(503);
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
    const result = await callProviderPipeline(instance, 'openaiImagesGenerations', model, { prompt: 'an orange circle', quality: 'low' }, undefined, options);
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
    const result = await callProviderPipeline(instance, 'openaiImagesGenerations', model, { prompt: 'an orange circle' }, undefined, noopUpstreamCallOptions());
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
    const result = await callProviderPipeline(instance, 'openaiImagesEdits', model, {
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
    const result = await callProviderPipeline(instance, 'openaiImagesEdits', model, {
      images: [{ type: 'upload', file: { bytes: new TextEncoder().encode('image'), name: 'image.png', type: 'image/png' } }],
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

  test.each(['openaiEmbeddings', 'openaiAudioTranscriptions', 'openaiChatCompletions', 'anthropicMessagesCountTokens', 'anthropicMessages'] as const)('%s has no Codex dispatch pipeline', operation => {
    expect(createCodexProvider(baseRecord).pipelines[operation]).toBeUndefined();
  });
});
