import { test } from 'vitest';

import { OLLAMA_ACCOUNT_PROBE_MIN_INTERVAL_MS, refreshOllamaAccount } from '../src/account-probe.ts';
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
  config: { baseUrl: 'https://ollama.com', apiKey: 'ollama_test', models: [] },
  state: null,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  modelsCache: null,
  hue: 210,
  ...overrides,
});

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

test('the account probe posts to ollama.com with the upstream API key and keeps the plan', async () => {
  const repo = withStateRepo();
  const seen: { url: string; method: string; authorization: string | null }[] = [];
  await withMockedFetch(
    async request => {
      seen.push({ url: request.url, method: request.method, authorization: request.headers.get('authorization') });
      // More arrives than the Go client's own type declares, in a second casing.
      return new Response(JSON.stringify({
        ID: 'usr_1', Email: 'a@example.com', plan: 'pro',
        SubscriptionPeriodStart: '2026-08-01T00:00:00Z', CustomerID: 'cus_1',
      }), { status: 200 });
    },
    async () => {
      const entry = await refreshOllamaAccount(UPSTREAM_ID, assertOllamaUpstreamRecord(cloudRecord()).config, directFetcher);
      assertEquals(entry.plan, 'pro');
      assertEquals(repo.read().account?.plan, 'pro');
    },
  );
  assertEquals(seen, [{ url: 'https://ollama.com/api/me', method: 'POST', authorization: 'Bearer ollama_test' }]);
});

// The server fills an empty plan in with "free" itself, so an absent field is a
// fact about the response rather than about the plan.
test('an account naming no plan is recorded as naming none', async () => {
  const repo = withStateRepo();
  await withMockedFetch(
    async () => new Response(JSON.stringify({ ID: 'usr_1', Email: 'a@example.com' }), { status: 200 }),
    async () => {
      await refreshOllamaAccount(UPSTREAM_ID, assertOllamaUpstreamRecord(cloudRecord()).config, directFetcher);
      assertEquals(repo.read().account?.plan, null);
    },
  );
});

test('a failed account read leaves the last known plan in place', async () => {
  const repo = withStateRepo({ account: { fetchedAt: 1_000, plan: 'max' } });
  await withMockedFetch(
    async () => new Response('{"error":"unauthorized"}\n', { status: 401 }),
    async () => {
      await assertRejects(
        () => refreshOllamaAccount(UPSTREAM_ID, assertOllamaUpstreamRecord(cloudRecord()).config, directFetcher),
        Error,
        'Ollama /api/me returned 401: {"error":"unauthorized"}',
      );
      assertEquals(repo.read().account?.plan, 'max');
    },
  );
});

// Driven through the provider rather than the scheduler, so the arming path is
// what the assertion covers.
test('an inference call reads the plan once a day and the usage windows every minute', async () => {
  const probesFor = async (state: unknown): Promise<{ me: number; usage: number }> => {
    withStateRepo(state);
    const counts = { me: 0, usage: 0 };
    const provider = createOllamaProvider(cloudRecord({ state }));
    const pending: Promise<unknown>[] = [];
    await withMockedFetch(
      request => {
        const { pathname } = new URL(request.url);
        if (pathname === '/api/me') counts.me++;
        if (pathname === '/api/usage') counts.usage++;
        if (pathname === '/api/me' || pathname === '/api/usage') return new Response('{}', { status: 200 });
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
    return counts;
  };

  assertEquals(await probesFor(null), { me: 1, usage: 1 });

  const now = Date.now();
  assertEquals(
    await probesFor({ account: { fetchedAt: now, plan: 'pro' }, usageProbe: { attemptedAt: now, observation: null, error: null } }),
    { me: 0, usage: 0 },
  );
  // A day-old plan beside a minute-old set of windows: only the plan is due.
  assertEquals(
    await probesFor({
      account: { fetchedAt: now - OLLAMA_ACCOUNT_PROBE_MIN_INTERVAL_MS, plan: 'pro' },
      usageProbe: { attemptedAt: now, observation: null, error: null },
    }),
    { me: 1, usage: 0 },
  );
});
