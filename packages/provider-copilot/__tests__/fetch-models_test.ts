import { expect, test, vi } from 'vitest';

import { createCopilotCredentials } from '../src/auth.ts';
import { fetchCopilotModels } from '../src/fetch-models.ts';
import { ProviderModelsUnavailableError, initProviderRepo, directFetcher, type UpstreamRecord } from '@floway-dev/provider';
import { assertEquals, jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

const installRepoAndConfig = async () => {
  const id = 'up_copilot_fetch_models_test';
  const githubToken = `ghu_${crypto.randomUUID().replace(/-/g, '')}`;
  const stub: UpstreamRecord = {
    id,
    kind: 'copilot',
    name: 'fetch-models-test',
    enabled: true,
    usageRefreshIntervalMinutes: 0,
    sortOrder: 0,
    createdAt: '2026-03-15T00:00:00.000Z',
    updatedAt: '2026-03-15T00:00:00.000Z',
    state: null,
    flagOverrides: {},
    disabledPublicModelIds: [],
    proxyFallbackList: [],
    modelPrefix: null,
    modelsCache: null,
    hue: 210,
    config: { githubHost: 'github.com', githubToken, user: { id: 1, login: 't', name: null, avatar_url: '' } },
  };
  initProviderRepo(() => ({
    recordUpstreamMetric: async () => {},
    upstreams: {
      getById: async () => ({ ...stub, configVersion: 1 }),
      saveState: async () => {},
    },
  }));
  return { id, githubHost: 'github.com', githubToken };
};

const copilotTokenResponse = (request: Request): Response | null => {
  const url = new URL(request.url);
  if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
  if (url.pathname === '/copilot_internal/v2/token') {
    return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
  }
  return null;
};

test('fetchCopilotModels throws ProviderModelsUnavailableError with null httpResponse on shape error', async () => {
  const config = await installRepoAndConfig();

  let thrown: unknown;
  await withMockedFetch(
    request => {
      const preflight = copilotTokenResponse(request);
      if (preflight) return preflight;
      const url = new URL(request.url);
      if (url.pathname === '/models') return jsonResponse({ object: 'list', data: [{ name: 'missing id' }] });
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      try { await fetchCopilotModels(config, async (url, init) => ({ ok: true, value: await directFetcher(url, init) }), createCopilotCredentials()); } catch (e) { thrown = e; }
    },
  );
  if (!(thrown instanceof ProviderModelsUnavailableError)) throw new Error('expected ProviderModelsUnavailableError');
  assertEquals(thrown.httpResponse, null);
});

test('fetchCopilotModels tags the request with the model-access intent and omits content-type', async () => {
  const config = await installRepoAndConfig();

  let observed: Headers | undefined;
  await withMockedFetch(
    request => {
      const preflight = copilotTokenResponse(request);
      if (preflight) return preflight;
      const url = new URL(request.url);
      if (url.pathname === '/models') {
        observed = request.headers;
        return jsonResponse({ object: 'list', data: [{ id: 'cm-1' }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      await fetchCopilotModels(config, async (url, init) => ({ ok: true, value: await directFetcher(url, init) }), createCopilotCredentials());
    },
  );

  if (!observed) throw new Error('expected /models fetch to have been observed');
  assertEquals(observed.get('openai-intent'), 'model-access');
  assertEquals(observed.get('x-interaction-type'), 'model-access');
  assertEquals(observed.get('content-type'), null);
});

test('a fetcher defect during catalog authorization propagates without retrying', async () => {
  const config = await installRepoAndConfig();
  const bug = new TypeError('catalog fetcher bug');
  const fetcher = vi.fn(async () => { throw bug; });
  await expect(fetchCopilotModels(config, fetcher, createCopilotCredentials())).rejects.toBe(bug);
  expect(fetcher).toHaveBeenCalledOnce();
});
