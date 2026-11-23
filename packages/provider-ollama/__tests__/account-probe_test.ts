import { expect, test } from 'vitest';

import { callOllama, ollamaInput, ollamaServices, settledProbes } from './pipeline-fixture.ts';
import { CREDIT_BALANCE, USAGE_TOTALS } from './usage-fixture.ts';
import { OLLAMA_ACCOUNT_PROBE_MIN_INTERVAL_MS, fetchOllamaAccount, refreshOllamaAccount } from '../src/account-probe.ts';
import { assertOllamaUpstreamRecord } from '../src/config.ts';
import { ollamaPipelines } from '../src/index.ts';
import { readOllamaUpstreamState } from '../src/state.ts';
import type { RunEvent } from '@floway-dev/pipeline';
import { directFetcher, initProviderRepo, type Fetcher, type UpstreamRecord } from '@floway-dev/provider';
import { assertEquals, stubProviderModel, withMockedFetch } from '@floway-dev/test-utils';

const UPSTREAM_ID = 'up_ollama_account';

const cloudRecord = (overrides: Partial<UpstreamRecord> = {}): UpstreamRecord => ({
  id: UPSTREAM_ID,
  kind: 'ollama',
  name: 'Ollama Cloud',
  enabled: true,
  usageRefreshIntervalMinutes: 0,
  sortOrder: 0,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  config: { baseUrl: 'https://ollama.com', apiKey: 'ollama_test', cloudUsage: true, models: [] },
  state: null,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  modelsCache: null,
  hue: 210,
  ...overrides,
});

// Verbatim from a live ollama.com account. The keys are capitalized and the
// body carries fields the client's own `UserResponse` never declares, so a
// reader keyed on that type's json tags — `plan`, `name`, `email` — finds
// nothing here.
const ME_BODY = {
  ID: '7787cb5e-5f5b-413f-9d59-1faf845206b4',
  CreatedAt: '2026-06-19T06:58:23.160933Z',
  Email: 'operator@example.com',
  Name: 'operator',
  Bio: '',
  AvatarURL: '/public/assets/00000000-0000-1000-8000-000000000000.png',
  FirstName: '',
  LastName: '',
  Links: [],
  Plan: 'free',
};

const withStateRepo = (state: unknown = null) => {
  let current = state;
  initProviderRepo(() => ({
    recordUpstreamMetric: async () => {},
    upstreams: {
      getById: async () => ({ ...cloudRecord(), state: current, configVersion: 1 }),
      saveState: async (_id, mutate) => {
        current = mutate(current, 1);
      },
    },
  }));
  return { read: () => readOllamaUpstreamState(current), replace: (value: unknown) => { current = value; } };
};

test('the account probe reads the plan and identity ollama.com actually sends', async () => {
  const { config } = assertOllamaUpstreamRecord(cloudRecord());
  await withMockedFetch(
    request => {
      assertEquals(request.url, 'https://ollama.com/api/me');
      assertEquals(request.method, 'POST');
      assertEquals(request.headers.get('authorization'), 'Bearer ollama_test');
      return new Response(JSON.stringify(ME_BODY), { status: 200 });
    },
    async () => {
      const account = await fetchOllamaAccount(config, directFetcher);
      assertEquals(account.plan, 'free');
      assertEquals(account.name, 'operator');
      assertEquals(account.email, 'operator@example.com');
    },
  );
});

test('the account slot resolves a race by read time', async () => {
  const { config } = assertOllamaUpstreamRecord(cloudRecord());
  const repo = withStateRepo();
  await withMockedFetch(
    () => new Response(JSON.stringify(ME_BODY), { status: 200 }),
    () => refreshOllamaAccount(UPSTREAM_ID, config, directFetcher),
  );
  const written = repo.read().account;
  assertEquals(written?.plan, 'free');

  // A reading that predates the stored one does not roll the slot back.
  const repoWithNewer = withStateRepo({ account: { ...written, fetchedAt: Date.now() + 60_000, plan: 'pro' } });
  await withMockedFetch(
    () => new Response(JSON.stringify(ME_BODY), { status: 200 }),
    () => refreshOllamaAccount(UPSTREAM_ID, config, directFetcher),
  );
  assertEquals(repoWithNewer.read().account?.plan, 'pro');
});

test('an inference call arms the account probe on its own daily interval', async () => {
  const repo = withStateRepo();
  const fetcher: Fetcher = async url => {
    switch (new URL(url).pathname) {
    case '/api/me': return Response.json(ME_BODY);
    case '/api/usage': return Response.json(USAGE_TOTALS);
    case '/api/balance': return Response.json(CREDIT_BALANCE);
    case '/v1/chat/completions': return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    default: throw new Error(`Unexpected request ${url}`);
    }
  };
  const services = ollamaServices(fetcher);
  const input = ollamaInput(cloudRecord(), stubProviderModel({ upstreamModelId: 'gpt-oss:120b' }), { messages: [] });
  const chatProbes = async () => {
    const events: RunEvent[] = [];
    await callOllama(ollamaPipelines.openaiChatCompletions, input, services, event => events.push(event));
    const probes = settledProbes(events);
    expect(probes.map(({ result }) => result)).toEqual(probes.map(() => expect.objectContaining({ ok: true, value: { persisted: true } })));
    return probes.map(({ name }) => name);
  };

  expect(await chatProbes()).toEqual(['ollama.usageProbe', 'ollama.accountProbe']);

  const hourOld = { account: { fetchedAt: Date.now() - 60 * 60 * 1000, plan: 'free', name: null, email: null } };
  repo.replace(hourOld);
  expect(await chatProbes()).toEqual(['ollama.usageProbe']);

  const dayOld = { account: { fetchedAt: Date.now() - OLLAMA_ACCOUNT_PROBE_MIN_INTERVAL_MS, plan: 'free', name: null, email: null } };
  repo.replace({ ...repo.read(), ...dayOld });
  expect(await chatProbes()).toEqual(['ollama.accountProbe']);
});
