import { assert, expect, test, vi } from 'vitest';

import { fetchOllamaAccount, refreshOllamaAccount } from '../src/account-probe.ts';
import { assertOllamaUpstreamRecord } from '../src/config.ts';
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
      const account = await fetchOllamaAccount(config, async (url, init) => ({ ok: true, value: await directFetcher(url, init) }));
      assert(account.ok);
      assertEquals(account.value.plan, 'free');
      assertEquals(account.value.name, 'operator');
      assertEquals(account.value.email, 'operator@example.com');
    },
  );
});

test('the account slot resolves a race by read time', async () => {
  const { config } = assertOllamaUpstreamRecord(cloudRecord());
  const repo = withStateRepo();
  await withMockedFetch(
    () => new Response(JSON.stringify(ME_BODY), { status: 200 }),
    () => refreshOllamaAccount(UPSTREAM_ID, config, async (url, init) => ({ ok: true, value: await directFetcher(url, init) })),
  );
  const written = repo.read().account;
  assertEquals(written?.plan, 'free');

  // A reading that predates the stored one does not roll the slot back.
  const repoWithNewer = withStateRepo({ account: { ...written, fetchedAt: Date.now() + 60_000, plan: 'pro' } });
  await withMockedFetch(
    () => new Response(JSON.stringify(ME_BODY), { status: 200 }),
    () => refreshOllamaAccount(UPSTREAM_ID, config, async (url, init) => ({ ok: true, value: await directFetcher(url, init) })),
  );
  assertEquals(repoWithNewer.read().account?.plan, 'pro');
});

test('the account reader drains malformed JSON and propagates an unexpected parser failure', async () => {
  const { config } = assertOllamaUpstreamRecord(cloudRecord());
  const malformed = new Response('{broken');
  await expect(fetchOllamaAccount(config, async () => ({ ok: true, value: malformed }))).resolves.toMatchObject({
    ok: false, error: expect.objectContaining({ cause: expect.any(SyntaxError) }),
  });
  expect(malformed.bodyUsed).toBe(true);
  expect(malformed.body?.locked).toBe(false);

  const bug = new TypeError('Ollama account parser bug');
  const parse = vi.spyOn(JSON, 'parse').mockImplementationOnce(() => { throw bug; });
  try {
    await expect(fetchOllamaAccount(config, async () => ({ ok: true, value: Response.json(ME_BODY) }))).rejects.toBe(bug);
  } finally {
    parse.mockRestore();
  }
});
