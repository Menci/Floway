import { test } from 'vitest';

import { OLLAMA_ACCOUNT_PROBE_MIN_INTERVAL_MS, fetchOllamaAccount, refreshOllamaAccount } from '../src/account-probe.ts';
import { assertOllamaUpstreamRecord } from '../src/config.ts';
import { createOllamaProvider } from '../src/provider.ts';
import { readOllamaUpstreamState } from '../src/state.ts';
import { directFetcher, initProviderRepo, type UpstreamRecord } from '@floway-dev/provider';
import { assertEquals, assertRejects, noopUpstreamCallOptions, stubProviderModel, withMockedFetch } from '@floway-dev/test-utils';

const UPSTREAM_ID = 'up_ollama_account';

const cloudRecord = (overrides: Partial<UpstreamRecord> = {}): UpstreamRecord => ({
  id: UPSTREAM_ID,
  kind: 'ollama',
  name: 'Ollama Cloud',
  enabled: true,
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
    upstreams: {
      getById: async () => ({ ...cloudRecord(), state: current }),
      saveState: async (_id, mutate) => {
        current = mutate(current);
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

test('an account naming no plan reads as naming none', async () => {
  const { config } = assertOllamaUpstreamRecord(cloudRecord());
  await withMockedFetch(
    () => new Response(JSON.stringify({ ...ME_BODY, Plan: '' }), { status: 200 }),
    async () => {
      const account = await fetchOllamaAccount(config, directFetcher);
      assertEquals(account.plan, null);
    },
  );
});

test('a rejected key surfaces the upstream status', async () => {
  const { config } = assertOllamaUpstreamRecord(cloudRecord());
  await withMockedFetch(
    () => new Response('{"error":"invalid credentials"}\n', { status: 401 }),
    async () => {
      const error = await assertRejects(() => fetchOllamaAccount(config, directFetcher));
      assertEquals(error.message, 'Ollama /api/me returned 401: {"error":"invalid credentials"}');
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

// Drives the provider so the arming decision is exercised where it is made.
const callChat = async (record: UpstreamRecord, onCall: (pathname: string) => void): Promise<void> => {
  const provider = createOllamaProvider(record);
  const pending: Promise<unknown>[] = [];
  await withMockedFetch(
    request => {
      const { pathname } = new URL(request.url);
      onCall(pathname);
      if (pathname === '/api/me') return new Response(JSON.stringify(ME_BODY), { status: 200 });
      if (pathname === '/api/usage') return new Response('{"limits":{}}', { status: 200 });
      return new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
    async () => {
      await provider.instance.callChatCompletions(
        stubProviderModel({ providerData: 'gpt-oss:120b' }),
        { messages: [] },
        undefined,
        noopUpstreamCallOptions({ waitUntil: promise => { pending.push(promise); } }),
      );
      await Promise.all(pending);
    },
  );
};

test('an inference call arms the account probe on its own daily interval', async () => {
  withStateRepo();
  let probes = 0;
  const count = (pathname: string) => { if (pathname === '/api/me') probes++; };

  await callChat(cloudRecord(), count);
  assertEquals(probes, 1);

  // Fresh enough for the account, stale for the usage window beside it: the
  // longer interval is what keeps this one from riding along.
  const hourOld = { account: { fetchedAt: Date.now() - 60 * 60 * 1000, plan: 'free', name: null, email: null } };
  await callChat(cloudRecord({ state: hourOld }), count);
  assertEquals(probes, 1);

  const dayOld = { account: { fetchedAt: Date.now() - OLLAMA_ACCOUNT_PROBE_MIN_INTERVAL_MS, plan: 'free', name: null, email: null } };
  await callChat(cloudRecord({ state: dayOld }), count);
  assertEquals(probes, 2);
});
