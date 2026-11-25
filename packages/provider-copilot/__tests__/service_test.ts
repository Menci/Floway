import { expect, test, vi } from 'vitest';

import { copilotUpstreamFact } from '../src/config.ts';
import { createCopilotService, getCopilotProvidedModels } from '../src/service.ts';
import { readCopilotUpstreamState } from '../src/state.ts';
import { getHeader, type FetchInit } from '@floway-dev/http';
import { move, Secret } from '@floway-dev/pipeline';
import { initProviderRepo, type UpstreamRecord } from '@floway-dev/provider';

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
  return () => upstream;
};

const tokenApi = 'https://api.github.com/copilot_internal/v2/token';
const copilotApi = 'https://copilot.test';

const exchangeResponse = () => Response.json({
  token: 'copilot-access-token',
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  endpoints: { api: copilotApi },
});

test('Copilot keeps GitHub and temporary bearer credentials marked when exposing facts and service results', async () => {
  const record = setup();
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
  const record = setup();
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
  const record = setup();
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
