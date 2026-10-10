import { test } from 'vitest';

import { CREDIT_BALANCE as BALANCE_BODY, USAGE_TOTALS as USAGE_BODY } from './usage-fixture.ts';
import { assertOllamaUpstreamRecord } from '../src/config.ts';
import { createOllamaProvider } from '../src/provider.ts';
import { readOllamaUpstreamState } from '../src/state.ts';
import {
  OLLAMA_USAGE_PROBE_MIN_INTERVAL_MS,
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

// Installs a repo whose single row starts from `state` and records every write.
const withStateRepo = (state: unknown = null) => {
  let current = state;
  const writes: unknown[] = [];
  initProviderRepo(() => ({
    upstreams: {
      getById: async () => ({ ...cloudRecord(), state: current }),
      saveState: async (_id, mutate) => {
        current = mutate(current);
        writes.push(current);
      },
    },
  }));
  return { read: () => readOllamaUpstreamState(current), writes };
};

test('the usage refresh reads both Ollama endpoints with the upstream API key for an unsaved draft', async () => {
  const { config } = assertOllamaUpstreamRecord(cloudRecord());
  const paths: string[] = [];
  await withMockedFetch(
    request => {
      const path = new URL(request.url).pathname;
      paths.push(path);
      assertEquals(request.method, 'GET');
      assertEquals(request.headers.get('authorization'), 'Bearer ollama_test');
      return Response.json(path === '/api/usage' ? USAGE_BODY : BALANCE_BODY);
    },
    async () => {
      const reading = await refreshOllamaUsageProbe('', config, directFetcher);
      assertEquals(reading.data.usage, USAGE_BODY);
      assertEquals(reading.data.balance, BALANCE_BODY);
    },
  );
  assertEquals(paths.toSorted(), ['/api/balance', '/api/usage']);
});

test.each(['/api/usage', '/api/balance'])('a failure of %s preserves both prior readings and records one refresh outcome', async failedPath => {
  const { config } = assertOllamaUpstreamRecord(cloudRecord());
  const repo = withStateRepo();
  await withMockedFetch(
    request => Response.json(new URL(request.url).pathname === '/api/usage' ? USAGE_BODY : BALANCE_BODY),
    () => refreshOllamaUsageProbe(UPSTREAM_ID, config, directFetcher),
  );
  const observed = repo.read();
  assertEquals(observed.usageProbe?.observation?.data.usage, USAGE_BODY);
  assertEquals(observed.usageProbe?.observation?.data.balance, BALANCE_BODY);
  assertEquals(repo.writes.length, 1);

  await withMockedFetch(
    request => new URL(request.url).pathname === failedPath
      ? new Response('invalid credentials', { status: 401 })
      : Response.json({ changed: true }),
    () => assertRejects(() => refreshOllamaUsageProbe(UPSTREAM_ID, config, directFetcher)),
  );
  const after = repo.read();
  assertEquals(after.usageProbe?.observation, observed.usageProbe?.observation);
  assertEquals(after.usageProbe?.error, `Ollama ${failedPath} returned 401: invalid credentials`);
  assertEquals(repo.writes.length, 2);
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
const callChat = async (record: UpstreamRecord, onUsageProbe: (path: string) => void): Promise<void> => {
  const provider = createOllamaProvider(record);
  const pending: Promise<unknown>[] = [];
  await withMockedFetch(
    request => {
      const path = new URL(request.url).pathname;
      if (path === '/api/usage' || path === '/api/balance') {
        onUsageProbe(path);
        return Response.json(path === '/api/usage' ? USAGE_BODY : BALANCE_BODY);
      }
      return new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
    async () => {
      await provider.instance.callOpenAIChatCompletions(
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
  const probes: string[] = [];
  await callChat(cloudRecord(), path => { probes.push(path); });
  assertEquals(probes, ['/api/usage', '/api/balance']);

  const justProbed = { usageProbe: { attemptedAt: Date.now(), observation: null, error: null } };
  await callChat(cloudRecord({ state: justProbed }), path => { probes.push(path); });
  assertEquals(probes.length, 2);

  const stale = { usageProbe: { attemptedAt: Date.now() - OLLAMA_USAGE_PROBE_MIN_INTERVAL_MS, observation: null, error: null } };
  await callChat(cloudRecord({ state: stale }), path => { probes.push(path); });
  assertEquals(probes, ['/api/usage', '/api/balance', '/api/usage', '/api/balance']);
});

test('token counting leaves the account windows untouched and arms no probe', async () => {
  withStateRepo();
  const provider = createOllamaProvider(cloudRecord());
  const pending: Promise<unknown>[] = [];
  let probes = 0;
  await withMockedFetch(
    request => {
      if (['/api/usage', '/api/balance'].includes(new URL(request.url).pathname)) probes++;
      return new Response('{"input_tokens":1}', { status: 200 });
    },
    async () => {
      await provider.instance.callAnthropicMessagesCountTokens(
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
