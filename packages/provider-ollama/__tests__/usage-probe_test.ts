import { test } from 'vitest';

import { assertOllamaUpstreamRecord } from '../src/config.ts';
import { createOllamaProvider } from '../src/provider.ts';
import { readOllamaUpstreamState } from '../src/state.ts';
import {
  OLLAMA_USAGE_PROBE_MIN_INTERVAL_MS,
  fetchOllamaUsageProbe,
  isOllamaUsageEnabled,
  refreshOllamaUsageProbe,
} from '../src/usage-probe.ts';
import { directFetcher, initProviderRepo, type UpstreamRecord } from '@floway-dev/provider';
import { assertEquals, assertRejects, noopUpstreamCallOptions, stubProviderModel, withMockedFetch } from '@floway-dev/test-utils';

const UPSTREAM_ID = 'up_ollama_usage';

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

// A live ollama.com reading, per the shape an account holder posted upstream.
// https://github.com/ollama/ollama/issues/12532#issuecomment-5117969589
const USAGE_BODY = {
  activity: {
    cost: '0.00000',
    period: { type: 'last_4_weeks', starting_at: '2026-07-06T00:00:00Z', ending_at: '2026-07-29T12:45:50Z' },
    models: [],
  },
  limits: {
    session: { usage: 0.046, models: [{ name: 'glm-5.2', request_count: 34 }] },
    weekly: { usage: 0.051, models: [{ name: 'glm-5.2', request_count: 254 }] },
  },
};

// Installs a repo whose single row starts from `state` and records every write.
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

test('the usage probe reads ollama.com with the upstream API key', async () => {
  const { config } = assertOllamaUpstreamRecord(cloudRecord());
  await withMockedFetch(
    request => {
      assertEquals(request.url, 'https://ollama.com/api/usage');
      assertEquals(request.method, 'GET');
      assertEquals(request.headers.get('authorization'), 'Bearer ollama_test');
      return new Response(JSON.stringify(USAGE_BODY), { status: 200 });
    },
    async () => {
      const observation = await fetchOllamaUsageProbe(config, directFetcher);
      assertEquals(observation.data, USAGE_BODY);
    },
  );
});

test('a probe failure keeps the last reading and records the error', async () => {
  const { config } = assertOllamaUpstreamRecord(cloudRecord());
  const repo = withStateRepo();

  await withMockedFetch(
    () => new Response(JSON.stringify(USAGE_BODY), { status: 200 }),
    () => refreshOllamaUsageProbe(UPSTREAM_ID, config, directFetcher),
  );
  const observed = repo.read().usageProbe?.observation;
  assertEquals(observed?.data, USAGE_BODY);

  await withMockedFetch(
    () => new Response('{"error":"invalid credentials"}', { status: 401 }),
    async () => {
      await assertRejects(() => refreshOllamaUsageProbe(UPSTREAM_ID, config, directFetcher));
    },
  );
  const after = repo.read().usageProbe;
  assertEquals(after?.observation, observed);
  assertEquals(after?.error, 'Ollama /api/usage returned 401: {"error":"invalid credentials"}');
});

test('usage is probed when the operator enabled it and a key is configured, and not otherwise', () => {
  const enabled = (config: Record<string, unknown>) =>
    isOllamaUsageEnabled(assertOllamaUpstreamRecord(cloudRecord({ config })).config);

  assertEquals(enabled({ baseUrl: 'https://ollama.com', apiKey: 'k', cloudUsage: true, models: [] }), true);
  // The option is the operator's answer, so it carries an upstream reached
  // through their own domain.
  assertEquals(enabled({ baseUrl: 'https://ollama.example.com', apiKey: 'k', cloudUsage: true, models: [] }), true);
  // No key to authenticate the read with.
  assertEquals(enabled({ baseUrl: 'https://ollama.com', cloudUsage: true, models: [] }), false);
  // The cloud endpoint alone does not turn it on; the stored option does.
  assertEquals(enabled({ baseUrl: 'https://ollama.com', apiKey: 'k', models: [] }), false);
});

// Drives the provider rather than the probe helpers so the arming decision —
// which call consumes the account's windows, and what the debounce reads — is
// exercised where it is made.
const callChat = async (record: UpstreamRecord, onUsageProbe: () => void): Promise<void> => {
  const provider = createOllamaProvider(record);
  const pending: Promise<unknown>[] = [];
  await withMockedFetch(
    request => {
      if (new URL(request.url).pathname === '/api/usage') {
        onUsageProbe();
        return new Response(JSON.stringify(USAGE_BODY), { status: 200 });
      }
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

test('an inference call arms the probe, and the stored attempt time debounces the next one', async () => {
  withStateRepo();
  let probes = 0;
  await callChat(cloudRecord(), () => { probes++; });
  assertEquals(probes, 1);

  const justProbed = { usageProbe: { attemptedAt: Date.now(), observation: null, error: null } };
  await callChat(cloudRecord({ state: justProbed }), () => { probes++; });
  assertEquals(probes, 1);

  const stale = { usageProbe: { attemptedAt: Date.now() - OLLAMA_USAGE_PROBE_MIN_INTERVAL_MS, observation: null, error: null } };
  await callChat(cloudRecord({ state: stale }), () => { probes++; });
  assertEquals(probes, 2);
});

test('token counting leaves the account windows untouched and arms no probe', async () => {
  withStateRepo();
  const provider = createOllamaProvider(cloudRecord());
  const pending: Promise<unknown>[] = [];
  let probes = 0;
  await withMockedFetch(
    request => {
      if (new URL(request.url).pathname === '/api/usage') probes++;
      return new Response('{"input_tokens":1}', { status: 200 });
    },
    async () => {
      await provider.instance.callMessagesCountTokens(
        stubProviderModel({ providerData: 'gpt-oss:120b' }),
        { messages: [], max_tokens: 16 },
        undefined,
        { ...noopUpstreamCallOptions({ waitUntil: promise => { pending.push(promise); } }), anthropicBeta: [] },
      );
      await Promise.all(pending);
    },
  );
  assertEquals(probes, 0);
});
