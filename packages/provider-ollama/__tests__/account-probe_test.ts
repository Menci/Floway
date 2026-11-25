import { test } from 'vitest';

import { CREDIT_BALANCE, USAGE_TOTALS } from './usage-fixture.ts';
import { OLLAMA_ACCOUNT_PROBE_MIN_INTERVAL_MS, fetchOllamaAccount, refreshOllamaAccount } from '../src/account-probe.ts';
import { assertOllamaUpstreamRecord } from '../src/config.ts';
import { createOllamaService } from '../src/service.ts';
import { readOllamaUpstreamState } from '../src/state.ts';
import { directFetcher, initProviderRepo, type UpstreamRecord } from '@floway-dev/provider';
import { assertEquals, withMockedFetch } from '@floway-dev/test-utils';

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
  return { read: () => readOllamaUpstreamState(current) };
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

test('the service refreshes the account on its own daily interval', async () => {
  withStateRepo();
  const service = createOllamaService();
  let probes = 0;
  const refresh = () => service.refreshProbes(UPSTREAM_ID, 1, async url => {
    const { pathname } = new URL(url);
    if (pathname === '/api/me') {
      probes++;
      return Response.json(ME_BODY);
    }
    return Response.json(pathname === '/api/usage' ? USAGE_TOTALS : CREDIT_BALANCE);
  }, (_probe, error) => { throw error; });

  await refresh();
  assertEquals(probes, 1);

  // Fresh enough for the account, stale for the usage window beside it: the
  // longer interval is what keeps this one from riding along.
  const hourOld = { account: { fetchedAt: Date.now() - 60 * 60 * 1000, plan: 'free', name: null, email: null } };
  withStateRepo(hourOld);
  await refresh();
  assertEquals(probes, 1);

  const dayOld = { account: { fetchedAt: Date.now() - OLLAMA_ACCOUNT_PROBE_MIN_INTERVAL_MS, plan: 'free', name: null, email: null } };
  withStateRepo(dayOld);
  await refresh();
  assertEquals(probes, 2);
});
