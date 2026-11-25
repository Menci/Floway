import { expect, test, vi } from 'vitest';

import { copilotUpstreamFact } from '../src/config.ts';
import { copilotPipelines } from '../src/pipelines/index.ts';
import { createCopilotService, getCopilotProvidedModels } from '../src/service.ts';
import { readCopilotUpstreamState } from '../src/state.ts';
import { getHeader, type FetchInit } from '@floway-dev/http';
import { move, run, Secret } from '@floway-dev/pipeline';
import { initProviderRepo, toProviderModelFact, type UpstreamRecord } from '@floway-dev/provider';

const setup = () => {
  let upstream: UpstreamRecord = {
    id: 'copilot-1',
    kind: 'copilot',
    name: 'Copilot',
    config: {
      githubHost: 'github.com',
      githubToken: 'github-token',
      user: { id: 1, login: 'test', name: null, avatar_url: 'https://example.test/avatar' },
    },
    state: null,
    enabled: true,
    usageRefreshIntervalMinutes: 0,
    sortOrder: 0,
    createdAt: '2026-03-15T00:00:00.000Z',
    updatedAt: '2026-03-15T00:00:00.000Z',
    flagOverrides: {},
    disabledPublicModelIds: [],
    proxyFallbackList: [],
    modelPrefix: null,
    modelsCache: null,
    hue: 210,
  };
  initProviderRepo(() => ({
    recordUpstreamMetric: async () => {},
    upstreams: {
      getById: async () => ({ ...upstream, configVersion: 1 }),
      async saveState(_id, mutate) { upstream = { ...upstream, state: mutate(upstream.state, 1) }; },
    },
  }));
  return {
    record: () => upstream,
    setState(state: unknown) { upstream = { ...upstream, state }; },
  };
};

const tokenApi = 'https://api.github.com/copilot_internal/v2/token';
const copilotApi = 'https://copilot.test';

const exchangeResponse = () => Response.json({
  token: 'copilot-access-token',
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  endpoints: { api: copilotApi },
});

test('Copilot keeps GitHub and temporary bearer credentials marked when exposing facts and service results', async () => {
  const { record } = setup();
  const upstream = move(copilotUpstreamFact(record()));
  const service = createCopilotService();
  const fetcher = vi.fn(async (_url: string, _init: FetchInit) => ({ ok: true, value: exchangeResponse() } as const));
  expect(upstream.config.githubToken).toBeInstanceOf(Secret);
  expect(JSON.stringify(upstream)).not.toContain('github-token');

  const credentials = await service.credentials(upstream, fetcher);
  const reused = await service.credentials(upstream, fetcher);
  expect(credentials).toMatchObject({ ok: true, value: { baseUrl: copilotApi, token: expect.any(Secret) } });
  expect(reused).toEqual(credentials);
  expect(JSON.stringify(credentials)).not.toContain('copilot-access-token');
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls[0][0]).toBe(tokenApi);
  expect(new Headers(fetcher.mock.calls[0][1].headers).get('authorization')).toBe('token github-token');
  expect(readCopilotUpstreamState(record().state).copilotToken?.token).toBe('copilot-access-token');
  const identity = service.identityHeaders();
  expect(getHeader(identity, 'x-request-id')).toBe(getHeader(identity, 'x-agent-task-id'));
});

test('Concurrent Copilot credentials share the service-owned GitHub exchange', async () => {
  const { record } = setup();
  const upstream = move(copilotUpstreamFact(record()));
  const release = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const fetcher = vi.fn(async (_url: string, init: FetchInit) => {
    expect(init.signal).toBeUndefined();
    entered.resolve();
    await release.promise;
    return { ok: true, value: exchangeResponse() } as const;
  });
  const service = createCopilotService();
  const first = service.credentials(upstream, fetcher);
  await entered.promise;
  const second = service.credentials(upstream, fetcher);
  release.resolve();
  const results = await Promise.all([first, second]);
  expect(fetcher).toHaveBeenCalledOnce();
  expect(results.map(result => result.ok)).toEqual([true, true]);
});

test('Copilot projects routing metadata and resolves raw variants from its stored catalog on a cold service', async () => {
  const { record } = setup();
  const service = createCopilotService();
  const fetcher = vi.fn(async (url: string, _init: FetchInit): Promise<Response> => {
    if (url === tokenApi) return exchangeResponse();
    if (url !== `${copilotApi}/models`) throw new Error(`Unexpected URL ${url}`);
    return Response.json({
      object: 'list',
      data: [
        { id: 'example-model', supported_endpoints: ['/responses'] },
        { id: 'example-model-fast', supported_endpoints: ['/responses'] },
      ],
    });
  });
  const models = await getCopilotProvidedModels(service, record(), fetcher);
  expect(models).toHaveLength(1);
  expect(models[0]).toMatchObject({ id: 'example-model', endpoints: { openaiResponses: {} } });
  expect(models[0]).not.toHaveProperty('providerData');
  expect(fetcher.mock.calls[1][0]).toBe(`${copilotApi}/models`);
  expect(new Headers(fetcher.mock.calls[1][1].headers).get('openai-intent')).toBe('model-access');
  const cold = createCopilotService();
  await expect(cold.selectModel(record().id, models[0].upstreamModelId, 'openaiResponses', { fast: true }))
    .resolves.toEqual({ kind: 'model', id: 'example-model-fast' });
});

test('a transport abort during the Copilot token exchange preserves its cause without retrying', async () => {
  const { record } = setup();
  const failure = { kind: 'abort', cause: 'transport stopped' } as const;
  const fetcher = vi.fn(async () => ({ ok: false, error: failure } as const));
  const result = await createCopilotService().credentials(copilotUpstreamFact(record()), fetcher);
  expect(result).toEqual({ ok: false, error: { kind: 'transport', error: failure } });
  expect(fetcher).toHaveBeenCalledOnce();
});

test('Copilot merges a refreshed catalog into the state written during its fetch', async () => {
  const { record, setState } = setup();
  const service = createCopilotService();
  const quotaSnapshot = { fetchedAt: 1, data: { observed_at: '2026-08-01T00:00:00.000Z', reset_at: null, quotas: {} } };
  const fetcher = async (url: string): Promise<Response> => {
    if (url === tokenApi) return exchangeResponse();
    if (url !== `${copilotApi}/models`) throw new Error(`Unexpected URL ${url}`);
    setState({ ...readCopilotUpstreamState(record().state), quotaSnapshot });
    return Response.json({
      object: 'list',
      data: [
        { id: 'claude-opus-4.7', supported_endpoints: ['/responses'], capabilities: { supports: { reasoning_effort: ['medium'] } } },
        { id: 'claude-opus-4.7-xhigh', supported_endpoints: ['/v1/messages'], capabilities: { supports: { reasoning_effort: ['xhigh'] } } },
      ],
    });
  };
  const [model] = await getCopilotProvidedModels(service, record(), fetcher);
  const state = readCopilotUpstreamState(record().state);
  expect(state.knownModels?.models).toHaveProperty('claude-opus-4.7');
  expect(state.copilotToken?.token).toBe('copilot-access-token');
  expect(state.quotaSnapshot).toEqual(quotaSnapshot);
  await expect(service.selectModel(record().id, model.upstreamModelId, 'openaiResponses', { reasoningEffort: 'xhigh' }))
    .resolves.toEqual({ kind: 'model', id: 'claude-opus-4.7' });

  await expect(getCopilotProvidedModels(service, record(), async () => new Response('unavailable', { status: 503 })))
    .rejects.toMatchObject({ httpResponse: { status: 503, body: 'unavailable' } });
  expect(readCopilotUpstreamState(record().state).knownModels).toEqual(state.knownModels);
});

test('Copilot dispatches the Responses wire variant for each requested service tier', async () => {
  const { record } = setup();
  const service = createCopilotService();
  const models = await getCopilotProvidedModels(service, record(), async url => {
    if (url === tokenApi) return exchangeResponse();
    if (url !== `${copilotApi}/models`) throw new Error(`Unexpected URL ${url}`);
    return Response.json({
      object: 'list',
      data: [
        { id: 'gpt-5.6-sol', supported_endpoints: ['/responses'] },
        { id: 'gpt-5.6-sol-fast', supported_endpoints: ['/responses'] },
        { id: 'grok-code-fast', supported_endpoints: ['/responses'] },
      ],
    });
  });
  expect(models.map(model => model.id)).toEqual(['gpt-5.6-sol', 'grok-code-fast']);
  const [model] = models;
  const fetcher = vi.fn(async (_url: string, _init: FetchInit) => ({
    ok: true,
    value: new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }),
  } as const));
  const tiers = [undefined, 'priority', 'fast', 'flex'] as const;
  const wireModels: string[] = [];

  for (const tier of tiers) {
    const started = run(copilotPipelines.openaiResponses, {
      'provider.upstream': move(copilotUpstreamFact(record())),
      'provider.model': move(toProviderModelFact(model)),
      'request.http': move({ url: 'https://floway.test', method: 'POST', headers: [], body: null }),
      'request.openaiResponses': move({ model: model.id, input: [], ...(tier !== undefined && { service_tier: tier }) }),
    }, { services: { copilot: service, fetcher: () => fetcher } });
    const result = await started.result;
    const outcome = result['response.openaiResponses'];
    if (outcome.kind !== 'stream') throw new Error('Expected OpenAI Responses stream');
    await Array.fromAsync(outcome.stream);
    await started.done;
    wireModels.push(result['response.modelKey']);
  }

  expect(fetcher).toHaveBeenCalledTimes(tiers.length);
  expect(wireModels).toEqual(['gpt-5.6-sol', 'gpt-5.6-sol-fast', 'gpt-5.6-sol-fast', 'gpt-5.6-sol']);
  for (const [index, [url, init]] of fetcher.mock.calls.entries()) {
    expect(url).toBe(`${copilotApi}/responses`);
    expect(typeof init.body).toBe('string');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.model).toBe(wireModels[index]);
    expect(body).not.toHaveProperty('service_tier');
  }
});

test.each([
  {
    quota: 'ent=300&ov=0.0&ovPerm=false&rem=90.0&rst=2026-09-01T00%3A00%3A00Z&totRem=270',
    remaining: 270,
  },
  {
    quota: 'ent=-2&ov=0.0&ovPerm=false&rem=0.0&rst=2026-09-01T00%3A00%3A00Z&totRem=0',
    remaining: null,
  },
])('Copilot quota outcome persists the valid observation or leaves the response available on failure', async ({ quota, remaining }) => {
  const { record } = setup();
  const service = createCopilotService();
  const fetcher = async (url: string): Promise<Response> => {
    if (url === tokenApi) return exchangeResponse();
    if (url === `${copilotApi}/models`) {
      return Response.json({ object: 'list', data: [{ id: 'gpt-chat', supported_endpoints: ['/chat/completions'] }] });
    }
    if (url === `${copilotApi}/chat/completions`) {
      return new Response('data: [DONE]\n\n', {
        headers: {
          'content-type': 'text/event-stream',
          'x-quota-snapshot-premium_interactions': quota,
        },
      });
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  const [model] = await getCopilotProvidedModels(service, record(), fetcher);
  const started = run(copilotPipelines.openaiChatCompletions, {
    'provider.upstream': move(copilotUpstreamFact(record())),
    'provider.model': move(toProviderModelFact(model)),
    'request.http': move({ url: 'https://floway.test', method: 'POST', headers: [], body: null }),
    'request.openaiChatCompletions': move({ model: model.id, messages: [] }),
  }, {
    services: {
      copilot: service,
      fetcher: () => async url => ({ ok: true, value: await fetcher(url) }),
    },
  });
  const result = await started.result;
  const outcome = result['response.openaiChatCompletions'];
  if (outcome.kind !== 'stream') throw new Error('Expected Chat Completions stream');
  await Array.fromAsync(outcome.stream);
  await started.done;
  expect(result['response.http']?.status).toBe(200);
  const snapshot = readCopilotUpstreamState(record().state).quotaSnapshot;
  if (remaining === null) expect(snapshot).toBeNull();
  else expect(snapshot).toMatchObject({ data: { quotas: { premium_interactions: { quota_remaining: remaining } } } });
});
