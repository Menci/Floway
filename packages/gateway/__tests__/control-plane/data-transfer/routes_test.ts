import { Hono } from 'hono';
import { expect, test, vi } from 'vitest';

// The import handler warms the SWR models cache for every saved upstream by
// calling each provider's getProvidedModels, which for Copilot / Custom would
// make real upstream HTTP requests the test sandbox cannot serve and hang
// until the vitest timeout. Stub the cache layer to a no-op so the import
// path's own behavior (upserts, identity validation, etc.) is what the tests
// exercise — the warm itself has dedicated coverage in models-cache_test.ts.
vi.mock('../../../src/data-plane/providers/models-cache.ts', () => ({
  fetchUpstreamModelsCached: () => Promise.resolve([]),
}));

import { exportData, importData } from '../../../src/control-plane/data-transfer/routes.ts';
import { exportQuery, importBody } from '../../../src/control-plane/schemas.ts';
import { upstreamRecordToFullJson } from '../../../src/control-plane/upstreams/serialize.ts';
import { DEFAULT_WEB_SEARCH_CONFIG } from '../../../src/data-plane/tools/web-search/config.ts';
import { initDumpBroker, initDumpStore } from '../../../src/dump/registry.ts';
import { zValidator } from '../../../src/middleware/zod-validator.ts';
import { initRepo } from '../../../src/repo/index.ts';
import type { ApiKey, PerformanceTelemetryRecord, WebSearchUsageRecord, StoredResponsesItem, UsageRecord, User } from '../../../src/repo/types.ts';
import { tokenUsageMetrics } from '../../../src/repo/usage-metrics.ts';
import { installDumpStubs } from '../../dump/test-fixtures.ts';
import { InMemoryRepo } from '../../repo/memory.ts';
import { ALL_PROVIDER_KINDS, type UpstreamRecord } from '@floway-dev/provider';
import { assertEquals } from '@floway-dev/test-utils';

const hasOwn = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

const KEY_A: ApiKey = {
  id: 'key-a',
  userId: 1,
  name: 'Alice',
  key: 'raw-a',
  serverSecret: '11'.repeat(32),
  createdAt: '2026-01-01T00:00:00.000Z',
  lastUsedAt: '2026-01-02T00:00:00.000Z',
  upstreamIds: null,
  deletedAt: null,
  dumpRetentionSeconds: null,
  responsesRetentionSeconds: 0,
};

const KEY_B: ApiKey = {
  id: 'key-b',
  userId: 1,
  name: 'Bob',
  key: 'raw-b',
  serverSecret: '22'.repeat(32),
  createdAt: '2026-02-01T00:00:00.000Z',
  upstreamIds: null,
  deletedAt: null,
  dumpRetentionSeconds: null,
  responsesRetentionSeconds: 0,
};

const SEED_ADMIN: User = {
  id: 1,
  username: 'admin',
  passwordHash: null,
  isAdmin: true,
  upstreamIds: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  deletedAt: null,
};

const USER_BOB: User = {
  id: 2,
  username: 'bob',
  passwordHash: 'pbkdf2-sha256$600000$c2FsdA==$aGFzaA==',
  isAdmin: false,
  upstreamIds: null,
  createdAt: '2026-02-01T00:00:00.000Z',
  deletedAt: null,
};

const CUSTOM_UPSTREAM: UpstreamRecord = {
  id: 'up_custom_a',
  kind: 'custom',
  name: 'Custom A',
  enabled: true,
  sortOrder: 10,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  flagOverrides: { 'messages-web-search-shim': true },
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  modelsCache: null,
  hue: 210,
  config: {
    baseUrl: 'https://custom.example.com',
    authStyle: 'bearer',
    apiKey: 'sk-custom',
    endpoints: { chatCompletions: {}, responses: {} },
    modelsFetch: { enabled: true, endpoint: '/models' },
  },
  state: null,
};

const COPILOT_UPSTREAM: UpstreamRecord = {
  id: 'up_copilot_a',
  kind: 'copilot',
  name: 'GitHub Copilot (alice)',
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  modelsCache: null,
  hue: 210,
  config: {
    githubToken: 'ghu-alice',
    user: {
      id: 100,
      login: 'alice',
      name: 'Alice',
      avatar_url: 'https://example.com/a.png',
    },
  },
  state: null,
};

const AZURE_UPSTREAM: UpstreamRecord = {
  id: 'up_azure_a',
  kind: 'azure',
  name: 'Azure A',
  enabled: true,
  sortOrder: 20,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  flagOverrides: {},
  disabledPublicModelIds: ['gpt-public'],
  proxyFallbackList: [],
  modelPrefix: null,
  modelsCache: null,
  hue: 210,
  config: {
    endpoint: 'https://example.openai.azure.com',
    apiKey: 'az-key',
    models: [
      {
        upstreamModelId: 'gpt-prod',
        publicModelId: 'gpt-public',
        kind: 'chat',
        endpoints: { chatCompletions: {}, responses: {}, embeddings: {} },
      },
      {
        upstreamModelId: 'deepseek-prod',
        kind: 'chat',
        endpoints: { chatCompletions: {} },
      },
    ],
  },
  state: null,
};

const OLLAMA_UPSTREAM: UpstreamRecord = {
  id: 'up_ollama_a',
  kind: 'ollama',
  name: 'Ollama A',
  enabled: true,
  sortOrder: 25,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  modelsCache: null,
  hue: 210,
  config: {
    baseUrl: 'https://ollama.com',
    apiKey: 'ollama-key',
    models: [
      {
        upstreamModelId: 'qwen3-coder:480b-cloud',
        kind: 'chat',
        endpoints: { chatCompletions: {} },
      },
    ],
  },
  state: null,
};

const CODEX_UPSTREAM: UpstreamRecord = {
  id: 'up_codex_a',
  kind: 'codex',
  name: 'ChatGPT Codex (alice)',
  enabled: true,
  sortOrder: 30,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  modelsCache: null,
  hue: 210,
  config: {
    accounts: [{
      email: 'alice@example.com',
      chatgptAccountId: 'acc_alice',
      chatgptUserId: 'usr_alice',
      planType: 'plus',
    }],
  },
  state: {
    accounts: [{
      chatgptAccountId: 'acc_alice',
      refresh_token: 'rt_alice_v3',
      state: 'active',
      state_updated_at: '2026-01-01T00:00:00.000Z',
      openaiDeviceId: '11111111-2222-4333-8444-555555555555',
    }],
  },
};

const USAGE_1: UsageRecord = {
  keyId: 'key-a',
  model: 'claude-opus-4-7',
  upstream: 'up_copilot_a',
  modelKey: 'claude-opus-4.7',
  hour: '2026-01-01T10',
  pricingSelector: { serviceTier: 'fast' },
  requests: 5,
  metrics: tokenUsageMetrics({ input: 1000, output: 500, input_cache_read: 120, input_cache_write: 80 }, null),
};

const USAGE_2: UsageRecord = {
  keyId: 'key-b',
  model: 'gpt-public',
  upstream: 'up_azure_a',
  modelKey: 'gpt-prod',
  hour: '2026-01-01T11',
  pricingSelector: {},
  requests: 3,
  metrics: tokenUsageMetrics({ input: 2000, output: 800, input_cache_read: 200, input_cache_write: 50 }, null),
};

const WEB_SEARCH_USAGE_1: WebSearchUsageRecord = {
  provider: 'tavily',
  keyId: 'key-a',
  action: 'search',
  hour: '2026-01-01T10',
  requests: 2,
};

const WEB_SEARCH_USAGE_2: WebSearchUsageRecord = {
  provider: 'microsoft-web-iq',
  keyId: 'key-b',
  action: 'fetch_page',
  hour: '2026-01-01T11',
  requests: 4,
};

const STORED_RESPONSES_ITEM: StoredResponsesItem = {
  id: 'msg_producer',
  apiKeyId: 'key-a',
  itemHash: 'stored-content-hash',
  payload: { item: { type: 'message', id: 'msg_producer', role: 'assistant', content: [] } },
  refreshedAt: 1_000,
};

const PERFORMANCE_1: PerformanceTelemetryRecord = {
  hour: '2026-01-01T10',
  keyId: 'key-a',
  model: 'claude-opus-4-7',
  upstream: 'up_copilot_a',
  operation: 'chat',
  runtimeLocation: 'SJC',
  requests: 5,
  ttftSamplesOk: 4,
  errorsWithOutput: 0,
  errorsNoOutput: 1,
  neutral: 0,
  tpotSamples: 4,
  ttftMsSum: 1000,
  tpotUsSum: 4000,
  buckets: [
    { metric: 'tpot_us', lower: 1000, upper: 1250, count: 4 },
    { metric: 'ttft_ms', lower: 100, upper: 142, count: 4 },
  ],
};

const PERFORMANCE_2: PerformanceTelemetryRecord = {
  hour: '2026-01-01T11',
  keyId: 'key-b',
  model: 'gpt-public',
  upstream: 'up_azure_a',
  operation: 'chat',
  runtimeLocation: 'LOCAL',
  requests: 3,
  ttftSamplesOk: 3,
  errorsWithOutput: 0,
  errorsNoOutput: 0,
  neutral: 0,
  tpotSamples: 3,
  ttftMsSum: 600,
  tpotUsSum: 1500,
  buckets: [
    { metric: 'tpot_us', lower: 500, upper: 625, count: 3 },
    { metric: 'ttft_ms', lower: 200, upper: 284, count: 3 },
  ],
};

const setup = () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const app = new Hono();
  app.get('/export', zValidator('query', exportQuery), exportData);
  app.post('/import', zValidator('json', importBody), importData);
  return { repo, app };
};

const doExport = async (app: Hono, includePerformance = false) => {
  const resp = await app.request(includePerformance ? '/export?include_performance=1' : '/export');
  assertEquals(resp.status, 200);
  return (await resp.json()) as Record<string, any>;
};

const doImport = async (app: Hono, mode: string, data: unknown, version: unknown = 19) => {
  const resp = await app.request('/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode, version, data }),
  });
  return { status: resp.status, body: (await resp.json()) as Record<string, any> };
};

const latestImportData = (overrides: Record<string, unknown> = {}) => ({
  users: [SEED_ADMIN],
  apiKeys: [],
  upstreams: [],
  usage: [],
  searchUsage: [],
  performanceIncluded: false,
  searchConfig: DEFAULT_WEB_SEARCH_CONFIG,
  ...overrides,
});

test('import round-trips a usage record carrying a positive input-length coordinate', async () => {
  const { app, repo } = setup();
  const longRow: UsageRecord = { ...USAGE_2, pricingSelector: { inputTokens: { operator: 'gt', value: 272000 } } };
  const result = await doImport(app, 'replace', latestImportData({ usage: [longRow] }));
  assertEquals(result.status, 200);
  assertEquals(await repo.usage.listAll(), [longRow]);
});

test('import validates generic pricing selectors', async () => {
  const { app } = setup();
  const unknown = await doImport(app, 'replace', latestImportData({ usage: [{ ...USAGE_2, pricingSelector: { unknown: 'x' } }] }));
  assertEquals(unknown.status, 400);
  assertEquals(String(unknown.body.error).includes('unknown pricing selector axis'), true);
  const fractional = await doImport(app, 'replace', latestImportData({ usage: [{ ...USAGE_2, pricingSelector: { inputTokens: { operator: 'gt', value: 272000.5 } } }] }));
  assertEquals(fractional.status, 400);
  assertEquals(String(fractional.body.error).includes('positive safe integer'), true);
});

test('export emits the v19 envelope with users and upstreams', async () => {
  const { app, repo } = setup();
  await repo.users.save(SEED_ADMIN);

  const result = await doExport(app);

  assertEquals(result.version, 19);
  assertEquals(typeof result.exportedAt, 'string');
  assertEquals(result.data.users, [SEED_ADMIN]);
  assertEquals(result.data.apiKeys, []);
  assertEquals(result.data.upstreams, []);
  assertEquals(result.data.proxies, []);
  assertEquals(result.data.usage, []);
  assertEquals(result.data.searchUsage, []);
  assertEquals(result.data.performanceIncluded, false);
  assertEquals(hasOwn(result.data, 'performance'), false);
  assertEquals(result.data.searchConfig, DEFAULT_WEB_SEARCH_CONFIG);
  assertEquals(hasOwn(result.data, 'githubAccounts'), false);
  assertEquals(hasOwn(result.data, 'upstreamConfigs'), false);
});

test('export includes full upstream configs and omits performance by default', async () => {
  const { app, repo } = setup();
  await repo.apiKeys.save(KEY_A);
  await repo.upstreams.save(COPILOT_UPSTREAM);
  await repo.upstreams.save(CUSTOM_UPSTREAM);
  await repo.upstreams.save(AZURE_UPSTREAM);
  await repo.usage.set(USAGE_1);
  await repo.webSearchUsage.set(WEB_SEARCH_USAGE_1);
  await repo.performance.set(PERFORMANCE_1);
  await repo.webSearchConfig.save({
    provider: 'tavily',
    tavily: { apiKey: 'tvly-test' },
    microsoftWebIq: { apiKey: 'ms-test' },
    jina: { apiKey: '' },
    passthroughOpenAiSearch: { enabled: false, upstreamId: '', model: '' },
  });

  const result = await doExport(app);

  assertEquals(result.data.apiKeys, [KEY_A]);
  assertEquals(result.data.upstreams.map((upstream: any) => upstream.id), ['up_copilot_a', 'up_custom_a', 'up_azure_a']);
  assertEquals(result.data.upstreams.find((upstream: any) => upstream.id === 'up_custom_a').config.apiKey, 'sk-custom');
  assertEquals(result.data.upstreams.find((upstream: any) => upstream.id === 'up_copilot_a').config.githubToken, 'ghu-alice');
  assertEquals(result.data.upstreams.find((upstream: any) => upstream.id === 'up_azure_a').config.apiKey, 'az-key');
  assertEquals(result.data.usage, [USAGE_1]);
  assertEquals(result.data.searchUsage, [WEB_SEARCH_USAGE_1]);
  assertEquals(result.data.performanceIncluded, false);
  assertEquals(hasOwn(result.data, 'performance'), false);
  assertEquals(result.data.searchConfig.provider, 'tavily');
});

test('export includes performance only when requested', async () => {
  const { app, repo } = setup();
  await repo.performance.set(PERFORMANCE_1);
  await repo.performance.set(PERFORMANCE_2);

  const defaultExport = await doExport(app);
  const fullExport = await doExport(app, true);

  assertEquals(defaultExport.data.performanceIncluded, false);
  assertEquals(hasOwn(defaultExport.data, 'performance'), false);
  assertEquals(fullExport.data.performanceIncluded, true);
  assertEquals(fullExport.data.performance, [PERFORMANCE_1, PERFORMANCE_2]);
});

test('import rejects any version other than the current one before deleting data', async () => {
  const { app, repo } = setup();
  await repo.apiKeys.save(KEY_A);
  await repo.upstreams.save(CUSTOM_UPSTREAM);

  const VERSION_ERROR = 'version must be 19 — older export formats are not supported; re-export from the current deployment';
  const previousV11 = await doImport(app, 'replace', latestImportData(), 11);
  const ancientVersion = await doImport(app, 'replace', { apiKeys: [] }, 1);
  const missingVersionResponse = await app.request('/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'replace', data: { apiKeys: [] } }),
  });
  const missingVersion = { status: missingVersionResponse.status, body: (await missingVersionResponse.json()) as Record<string, any> };

  assertEquals(previousV11.status, 400);
  assertEquals(previousV11.body.error, VERSION_ERROR);
  assertEquals(ancientVersion.status, 400);
  assertEquals(ancientVersion.body.error, VERSION_ERROR);
  assertEquals(missingVersion.status, 400);
  assertEquals(missingVersion.body.error, VERSION_ERROR);
  assertEquals(await repo.apiKeys.list(), [KEY_A]);
  assertEquals((await repo.upstreams.list()).map(upstream => upstream.id), ['up_custom_a']);
});

test('import replace writes upstreams and clears replaced collections', async () => {
  const { app, repo } = setup();
  await repo.apiKeys.save({ ...KEY_A, responsesRetentionSeconds: 24 * 60 * 60 });
  await repo.upstreams.save(CUSTOM_UPSTREAM);
  await repo.usage.set(USAGE_1);
  await repo.webSearchUsage.set(WEB_SEARCH_USAGE_1);
  await repo.responsesItems.insertMany([STORED_RESPONSES_ITEM], 0);
  await repo.webSearchConfig.save({
    provider: 'tavily',
    tavily: { apiKey: 'old' },
    microsoftWebIq: { apiKey: '' },
    jina: { apiKey: '' },
    passthroughOpenAiSearch: { enabled: false, upstreamId: '', model: '' },
  });

  const result = await doImport(app, 'replace', {
    users: [SEED_ADMIN],
    apiKeys: [KEY_B],
    upstreams: [upstreamRecordToFullJson(AZURE_UPSTREAM)],
    usage: [USAGE_2],
    searchUsage: [WEB_SEARCH_USAGE_2],
    performanceIncluded: false,
    searchConfig: {
      provider: 'microsoft-web-iq',
      tavily: { apiKey: '' },
      microsoftWebIq: { apiKey: 'ms-new' },
      jina: { apiKey: '' },
      passthroughOpenAiSearch: { enabled: false, upstreamId: '', model: '' },
    },
  });

  assertEquals(result.status, 200);
  assertEquals(result.body.imported, { users: 1, apiKeys: 1, upstreams: 1, proxies: 0, usage: 1, searchUsage: 1, performance: 0 });
  const restoredKey = await repo.apiKeys.findByRawKey(KEY_B.key);
  if (restoredKey === null) throw new Error('restored key missing');
  assertEquals(restoredKey, KEY_B);
  assertEquals(await repo.upstreams.list(), [AZURE_UPSTREAM]);
  assertEquals(await repo.usage.listAll(), [USAGE_2]);
  assertEquals(await repo.webSearchUsage.listAll(), [WEB_SEARCH_USAGE_2]);
  assertEquals(await repo.responsesItems.lookupMany('key-a', [STORED_RESPONSES_ITEM.id], 0), []);
  assertEquals(await repo.webSearchConfig.get(), {
    provider: 'microsoft-web-iq',
    tavily: { apiKey: '' },
    microsoftWebIq: { apiKey: 'ms-new' },
    jina: { apiKey: '' },
    passthroughOpenAiSearch: { enabled: false, upstreamId: '', model: '' },
  });
});

test('replace import preserves API-key IDs and imported references', async () => {
  const { app, repo } = setup();
  await repo.apiKeys.save(KEY_A);
  const result = await doImport(app, 'replace', latestImportData({
    apiKeys: [KEY_A],
    usage: [USAGE_1],
    searchUsage: [WEB_SEARCH_USAGE_1],
    performanceIncluded: true,
    performance: [PERFORMANCE_1],
  }));
  assertEquals(result.status, 200);

  const restored = await repo.apiKeys.findByRawKey(KEY_A.key);
  if (restored === null) throw new Error('restored key missing');
  assertEquals(restored.id, KEY_A.id);
  assertEquals((await repo.usage.listAll())[0].keyId, KEY_A.id);
  assertEquals((await repo.webSearchUsage.listAll())[0].keyId, KEY_A.id);
  assertEquals((await repo.performance.listAll())[0].keyId, KEY_A.id);
});

test('import merge upserts by repository key without clearing unrelated rows', async () => {
  const { app, repo } = setup();
  await repo.apiKeys.save(KEY_A);
  await repo.upstreams.save(CUSTOM_UPSTREAM);
  await repo.usage.set({ ...USAGE_1, requests: 10 });
  await repo.webSearchUsage.set({ ...WEB_SEARCH_USAGE_1, requests: 10 });

  const updatedCustom = { ...CUSTOM_UPSTREAM, name: 'Custom Updated', updatedAt: '2026-03-01T00:00:00.000Z' } satisfies UpstreamRecord;
  const result = await doImport(app, 'merge', latestImportData({
    apiKeys: [{ ...KEY_A, name: 'Alice Updated' }, KEY_B],
    upstreams: [upstreamRecordToFullJson(updatedCustom), upstreamRecordToFullJson(COPILOT_UPSTREAM)],
    usage: [USAGE_1],
    searchUsage: [WEB_SEARCH_USAGE_1],
  }));

  assertEquals(result.status, 200);
  assertEquals((await repo.apiKeys.list()).map(key => key.name), ['Alice Updated', 'Bob']);
  assertEquals((await repo.upstreams.list()).map(upstream => [upstream.id, upstream.name]), [
    ['up_copilot_a', 'GitHub Copilot (alice)'],
    ['up_custom_a', 'Custom Updated'],
  ]);
  assertEquals(await repo.usage.listAll(), [USAGE_1]);
  assertEquals(await repo.webSearchUsage.listAll(), [WEB_SEARCH_USAGE_1]);
});

test('import replace handles performance inclusion explicitly', async () => {
  const { app, repo } = setup();
  await repo.performance.set(PERFORMANCE_1);

  const preserve = await doImport(app, 'replace', latestImportData());
  assertEquals(preserve.status, 200);
  assertEquals(await repo.performance.listAll(), [PERFORMANCE_1]);

  const replace = await doImport(app, 'replace', {
    users: [SEED_ADMIN],
    apiKeys: [],
    upstreams: [],
    usage: [],
    searchUsage: [],
    performanceIncluded: true,
    performance: [PERFORMANCE_2],
    searchConfig: DEFAULT_WEB_SEARCH_CONFIG,
  });

  assertEquals(replace.status, 200);
  assertEquals(await repo.performance.listAll(), [PERFORMANCE_2]);
});

test('import accepts audio transcription performance rows', async () => {
  const { app, repo } = setup();
  const audioPerformance: PerformanceTelemetryRecord = {
    ...PERFORMANCE_2,
    operation: 'audio_transcription',
    ttftSamplesOk: 0,
    neutral: PERFORMANCE_2.requests,
    tpotSamples: 0,
    ttftMsSum: 0,
    tpotUsSum: 0,
    buckets: [],
  };
  const result = await doImport(app, 'replace', latestImportData({
    performanceIncluded: true,
    performance: [audioPerformance],
  }));
  assertEquals(result.status, 200);
  assertEquals(await repo.performance.listAll(), [audioPerformance]);
});

test('import rejects performance records that break the recorder invariants', async () => {
  const { app } = setup();

  const withPerf = (record: PerformanceTelemetryRecord) => latestImportData({
    performanceIncluded: true,
    performance: [record],
  });

  // Partition sum ≠ requests. The four disjoint counters must add up to
  // requests on any row the recorder wrote; anything else is corruption.
  const partitionMismatch = await doImport(app, 'replace', withPerf({
    ...PERFORMANCE_1,
    requests: 5,
    ttftSamplesOk: 4,
    errorsWithOutput: 0,
    errorsNoOutput: 0,
    neutral: 0,
  }));
  assertEquals(partitionMismatch.status, 400);
  assertEquals(String(partitionMismatch.body.error).includes('ttftSamplesOk + errorsWithOutput + errorsNoOutput + neutral must equal requests'), true);

  // tpotSamples > ttftSamplesOk + errorsWithOutput — a TPOT sample requires a
  // preceding TTFT stamp, so it can never exceed the union of healthy and
  // partial-output TTFT rows.
  const tpotBeyondTtft = await doImport(app, 'replace', withPerf({
    ...PERFORMANCE_1,
    requests: 5,
    ttftSamplesOk: 2,
    errorsWithOutput: 0,
    errorsNoOutput: 3,
    neutral: 0,
    tpotSamples: 3,
    buckets: [
      { metric: 'ttft_ms', lower: 100, upper: 142, count: 2 },
      { metric: 'tpot_us', lower: 1000, upper: 1250, count: 3 },
    ],
  }));
  assertEquals(tpotBeyondTtft.status, 400);
  assertEquals(String(tpotBeyondTtft.body.error).includes('tpotSamples must not exceed ttftSamplesOk + errorsWithOutput'), true);

  // ttft_ms bucket sum does not match ttftSamplesOk + errorsWithOutput. Every
  // TTFT sample increments exactly one bucket entry, so the histogram sum has
  // to equal the counter sum or percentile queries lie.
  const ttftBucketMismatch = await doImport(app, 'replace', withPerf({
    ...PERFORMANCE_1,
    requests: 5,
    ttftSamplesOk: 4,
    errorsWithOutput: 0,
    errorsNoOutput: 1,
    neutral: 0,
    tpotSamples: 4,
    buckets: [
      { metric: 'ttft_ms', lower: 100, upper: 142, count: 3 },
      { metric: 'tpot_us', lower: 1000, upper: 1250, count: 4 },
    ],
  }));
  assertEquals(ttftBucketMismatch.status, 400);
  assertEquals(String(ttftBucketMismatch.body.error).includes('ttft_ms bucket sum (3) must equal ttftSamplesOk + errorsWithOutput (4)'), true);

  // tpot_us bucket sum does not match tpotSamples
  const tpotBucketMismatch = await doImport(app, 'replace', withPerf({
    ...PERFORMANCE_1,
    tpotSamples: 4,
    buckets: [
      { metric: 'ttft_ms', lower: 100, upper: 142, count: 4 },
      { metric: 'tpot_us', lower: 1000, upper: 1250, count: 2 },
    ],
  }));
  assertEquals(tpotBucketMismatch.status, 400);
  assertEquals(String(tpotBucketMismatch.body.error).includes('tpot_us bucket sum (2) must equal tpotSamples (4)'), true);

  // Duplicate {metric, lower, upper} tuples would silently over-count in
  // the aggregator's per-bucket merge.
  const duplicateBucket = await doImport(app, 'replace', withPerf({
    ...PERFORMANCE_1,
    ttftSamplesOk: 4,
    errorsWithOutput: 0,
    errorsNoOutput: 1,
    neutral: 0,
    requests: 5,
    tpotSamples: 4,
    buckets: [
      { metric: 'ttft_ms', lower: 100, upper: 142, count: 2 },
      { metric: 'ttft_ms', lower: 100, upper: 142, count: 2 },
      { metric: 'tpot_us', lower: 1000, upper: 1250, count: 4 },
    ],
  }));
  assertEquals(duplicateBucket.status, 400);
  assertEquals(String(duplicateBucket.body.error).includes('duplicate bucket entry'), true);
});

test('import rejects missing upstreams before clearing existing data', async () => {
  const { app, repo } = setup();
  await repo.apiKeys.save(KEY_A);
  await repo.upstreams.save(CUSTOM_UPSTREAM);
  await repo.usage.set(USAGE_1);

  const result = await doImport(app, 'replace', {
    users: [SEED_ADMIN],
    apiKeys: [KEY_B],
    usage: [USAGE_2],
    searchUsage: [],
    performanceIncluded: false,
    searchConfig: DEFAULT_WEB_SEARCH_CONFIG,
  });

  assertEquals(result.status, 400);
  assertEquals(result.body.error, 'invalid upstreams: upstreams must be an array');
  assertEquals(await repo.apiKeys.list(), [KEY_A]);
  assertEquals(await repo.upstreams.list(), [CUSTOM_UPSTREAM]);
  assertEquals(await repo.usage.listAll(), [USAGE_1]);
});

test('ollama upstreams export and import round-trip', async () => {
  const { app, repo } = setup();
  await repo.upstreams.save(OLLAMA_UPSTREAM);
  await repo.webSearchConfig.save(DEFAULT_WEB_SEARCH_CONFIG);

  const result = await doExport(app);
  const exportedOllama = result.data.upstreams.find((upstream: any) => upstream.id === 'up_ollama_a');
  assertEquals(exportedOllama.config, OLLAMA_UPSTREAM.config);

  const replaceResult = await doImport(app, 'replace', {
    users: [SEED_ADMIN],
    apiKeys: [],
    upstreams: [exportedOllama],
    usage: [],
    searchUsage: [],
    performanceIncluded: false,
    searchConfig: DEFAULT_WEB_SEARCH_CONFIG,
  });
  assertEquals(replaceResult.status, 200);
  assertEquals(await repo.upstreams.list(), [OLLAMA_UPSTREAM]);
});

test('codex upstreams export and import round-trip with state intact', async () => {
  const { app, repo } = setup();
  await repo.upstreams.save(CODEX_UPSTREAM);
  await repo.webSearchConfig.save(DEFAULT_WEB_SEARCH_CONFIG);

  const result = await doExport(app);
  const exportedCodex = result.data.upstreams.find((upstream: any) => upstream.id === 'up_codex_a');
  assertEquals(exportedCodex.config, CODEX_UPSTREAM.config);
  assertEquals(exportedCodex.state, CODEX_UPSTREAM.state);

  const replaceResult = await doImport(app, 'replace', {
    users: [SEED_ADMIN],
    apiKeys: [],
    upstreams: [exportedCodex],
    usage: [],
    searchUsage: [],
    performanceIncluded: false,
    searchConfig: DEFAULT_WEB_SEARCH_CONFIG,
  });
  assertEquals(replaceResult.status, 200);
  assertEquals(await repo.upstreams.list(), [CODEX_UPSTREAM]);
});

test('codex import rejects when state is missing', async () => {
  const { app } = setup();
  const { state: _dropped, ...stateless } = upstreamRecordToFullJson(CODEX_UPSTREAM);
  const result = await doImport(app, 'replace', {
    users: [SEED_ADMIN],
    apiKeys: [],
    upstreams: [{ ...stateless, state: null }],
    usage: [],
    searchUsage: [],
    performanceIncluded: false,
    searchConfig: DEFAULT_WEB_SEARCH_CONFIG,
  });
  assertEquals(result.status, 400);
  assertEquals(result.body.error.includes('codex upstream is missing state'), true);
});

test('codex import rejects unknown keys in state', async () => {
  const { app } = setup();
  const exported = upstreamRecordToFullJson(CODEX_UPSTREAM);
  const result = await doImport(app, 'replace', {
    users: [SEED_ADMIN],
    apiKeys: [],
    upstreams: [{ ...exported, state: { ...(exported.state as object), smuggled: 'x' } }],
    usage: [],
    searchUsage: [],
    performanceIncluded: false,
    searchConfig: DEFAULT_WEB_SEARCH_CONFIG,
  });
  assertEquals(result.status, 400);
  assertEquals(result.body.error.includes('unexpected key'), true);
});

test('import rejects negative historical unit prices with a metric-specific error', async () => {
  const { app } = setup();
  const result = await doImport(app, 'replace', latestImportData({
    usage: [{
      ...USAGE_2,
      metrics: [{ metric: 'input_tokens', quantity: '2000', unitPrice: '-0.01' }],
    }],
  }));

  assertEquals(result.status, 400);
  assertEquals(result.body.error, 'invalid usage at index 0: metric unitPrice must be non-negative: "-0.01"');
});

test('v19 import validates usage metric rows', async () => {
  const { app } = setup();
  const missingMetrics = await doImport(app, 'replace', latestImportData({
    usage: [{ ...USAGE_2, metrics: undefined }],
  }));
  const unknownMetric = await doImport(app, 'replace', latestImportData({
    usage: [{ ...USAGE_2, metrics: [{ metric: 'imput', quantity: '1', unitPrice: null }] }],
  }));
  const invalidQuantity = await doImport(app, 'replace', latestImportData({
    usage: [{ ...USAGE_2, metrics: [{ metric: 'input_tokens', quantity: -1, unitPrice: null }] }],
  }));
  const duplicateMetric = await doImport(app, 'replace', latestImportData({
    usage: [{
      ...USAGE_2,
      metrics: [
        { metric: 'input_tokens', quantity: '1', unitPrice: null },
        { metric: 'input_tokens', quantity: '2', unitPrice: null },
      ],
    }],
  }));

  assertEquals(missingMetrics.body.error, 'invalid usage at index 0: metrics must be an array');
  assertEquals(unknownMetric.body.error, 'invalid usage at index 0: unknown usage metric: "imput"');
  assertEquals(invalidQuantity.body.error, 'invalid usage at index 0: metric quantity must be a decimal string: -1');
  assertEquals(duplicateMetric.body.error, 'invalid usage at index 0: duplicate usage metric: input_tokens');
});

test('import rejects invalid records before clearing existing data', async () => {
  const { app, repo } = setup();
  await repo.apiKeys.save(KEY_A);
  await repo.upstreams.save(CUSTOM_UPSTREAM);
  await repo.webSearchUsage.set(WEB_SEARCH_USAGE_1);

  const badApiKeys = await doImport(app, 'replace', {
    users: [SEED_ADMIN],
    apiKeys: [{ ...KEY_B, key: '' }],
    upstreams: [],
    usage: [],
    searchUsage: [],
    performanceIncluded: false,
    searchConfig: DEFAULT_WEB_SEARCH_CONFIG,
  });
  const badUsage = await doImport(app, 'replace', {
    users: [SEED_ADMIN],
    apiKeys: [],
    upstreams: [],
    usage: [{ ...USAGE_2, requests: -1 }],
    searchUsage: [],
    performanceIncluded: false,
    searchConfig: DEFAULT_WEB_SEARCH_CONFIG,
  });
  const badUpstream = await doImport(app, 'replace', {
    users: [SEED_ADMIN],
    apiKeys: [],
    upstreams: [{ ...upstreamRecordToFullJson(CUSTOM_UPSTREAM), config: { baseUrl: 'https://custom.example.com', authStyle: 'bearer', apiKey: 'sk', endpoints: { bogus: {} } } }],
    usage: [],
    searchUsage: [],
    performanceIncluded: false,
    searchConfig: DEFAULT_WEB_SEARCH_CONFIG,
  });
  const badFixes = await doImport(app, 'replace', {
    users: [SEED_ADMIN],
    apiKeys: [],
    upstreams: [{ ...upstreamRecordToFullJson(CUSTOM_UPSTREAM), flag_overrides: { 'made-up-fix': true } }],
    usage: [],
    searchUsage: [],
    performanceIncluded: false,
    searchConfig: DEFAULT_WEB_SEARCH_CONFIG,
  });
  const badWebSearchUsage = await doImport(app, 'replace', {
    users: [SEED_ADMIN],
    apiKeys: [],
    upstreams: [],
    usage: [],
    searchUsage: [{ provider: 'not-real', keyId: 'key-a', hour: '2026-01-01T10', requests: 1 }],
    performanceIncluded: false,
    searchConfig: DEFAULT_WEB_SEARCH_CONFIG,
  });

  assertEquals(badApiKeys.status, 400);
  assertEquals(badApiKeys.body.error, 'invalid apiKeys at index 0: key must be a non-empty string');
  assertEquals(badUsage.status, 400);
  assertEquals(badUsage.body.error, 'invalid usage at index 0: record has invalid usage fields');
  assertEquals(badUpstream.status, 400);
  assertEquals(String(badUpstream.body.error).includes('invalid upstreams at index 0'), true);
  assertEquals(badFixes.status, 400);
  assertEquals(badFixes.body.error, 'invalid upstreams at index 0: Unknown flag_overrides ids: made-up-fix');
  assertEquals(badWebSearchUsage.status, 400);
  assertEquals(badWebSearchUsage.body.error, 'invalid searchUsage at index 0: invalid provider');
  assertEquals(await repo.apiKeys.list(), [KEY_A]);
  assertEquals(await repo.upstreams.list(), [CUSTOM_UPSTREAM]);
  assertEquals(await repo.webSearchUsage.listAll(), [WEB_SEARCH_USAGE_1]);
});

test('import strips unknown fields at transferable record boundaries', async () => {
  const { app, repo } = setup();
  const result = await doImport(app, 'replace', latestImportData({
    users: [{ ...SEED_ADMIN, smuggled: true }],
    apiKeys: [{ ...KEY_A, smuggled: true }],
    upstreams: [{ ...upstreamRecordToFullJson(CUSTOM_UPSTREAM), smuggled: true }],
    proxies: [{ id: 'p1', name: 'Proxy', url: HTTP_PROXY_URL, dial_timeout_seconds: null, smuggled: true }],
    usage: [{
      ...USAGE_1,
      smuggled: true,
      metrics: USAGE_1.metrics.map(metric => ({ ...metric, smuggled: true })),
    }],
    searchUsage: [{ ...WEB_SEARCH_USAGE_1, smuggled: true }],
    performanceIncluded: true,
    performance: [{
      ...PERFORMANCE_1,
      smuggled: true,
      buckets: PERFORMANCE_1.buckets.map(bucket => ({ ...bucket, smuggled: true })),
    }],
  }));

  assertEquals(result.status, 200);
  for (const record of [
    ...(await repo.users.listIncludingDeleted()),
    ...(await repo.apiKeys.listIncludingDeleted()),
    ...(await repo.upstreams.list()),
    ...(await repo.proxies.list()),
    ...(await repo.usage.listAll()),
    ...(await repo.webSearchUsage.listAll()),
    ...(await repo.performance.listAll()),
  ]) {
    assertEquals('smuggled' in record, false);
  }
  assertEquals((await repo.usage.listAll())[0].metrics.some(metric => 'smuggled' in metric), false);
  assertEquals((await repo.performance.listAll())[0].buckets.some(bucket => 'smuggled' in bucket), false);
});

test('import trims every formerly normalized non-empty string field', async () => {
  const { app, repo } = setup();
  const upstream = upstreamRecordToFullJson(CUSTOM_UPSTREAM);
  const result = await doImport(app, 'replace', latestImportData({
    users: [{ ...SEED_ADMIN, createdAt: `  ${SEED_ADMIN.createdAt}  ` }],
    apiKeys: [{
      ...KEY_A,
      id: `  ${KEY_A.id}  `,
      name: `  ${KEY_A.name}  `,
      key: `  ${KEY_A.key}  `,
      createdAt: `  ${KEY_A.createdAt}  `,
      lastUsedAt: '  2026-03-01T00:00:00.000Z  ',
    }],
    upstreams: [{
      ...upstream,
      id: `  ${upstream.id}  `,
      name: `  ${upstream.name}  `,
      created_at: `  ${upstream.created_at}  `,
      updated_at: `  ${upstream.updated_at}  `,
    }],
    proxies: [{ id: '  p1  ', name: '  Proxy  ', url: `  ${HTTP_PROXY_URL}  `, dial_timeout_seconds: null }],
  }));

  assertEquals(result.status, 200);
  assertEquals((await repo.users.listIncludingDeleted())[0].createdAt, SEED_ADMIN.createdAt);
  assertEquals(await repo.apiKeys.listIncludingDeleted(), [{ ...KEY_A, lastUsedAt: '2026-03-01T00:00:00.000Z' }]);
  assertEquals((await repo.upstreams.list())[0].id, CUSTOM_UPSTREAM.id);
  assertEquals((await repo.upstreams.list())[0].name, CUSTOM_UPSTREAM.name);
  assertEquals((await repo.upstreams.list())[0].createdAt, CUSTOM_UPSTREAM.createdAt);
  assertEquals((await repo.upstreams.list())[0].updatedAt, CUSTOM_UPSTREAM.updatedAt);
  assertEquals((await repo.proxies.list()).map(proxy => ({
    id: proxy.id,
    name: proxy.name,
    url: proxy.url,
    dialTimeoutSeconds: proxy.dialTimeoutSeconds,
  })), [{ id: 'p1', name: 'Proxy', url: HTTP_PROXY_URL, dialTimeoutSeconds: null }]);

  const whitespaceOnly = await doImport(app, 'merge', latestImportData({ apiKeys: [{ ...KEY_A, key: '   ' }] }));
  assertEquals(whitespaceOnly.body.error, 'invalid apiKeys at index 0: key must be a non-empty string');
});

test('import retains optional defaults from the v19 wire contract', async () => {
  const { app, repo } = setup();
  const { disabled_public_model_ids: _disabled, model_prefix: _prefix, ...upstream } = upstreamRecordToFullJson(CUSTOM_UPSTREAM);
  const result = await doImport(app, 'replace', latestImportData({
    apiKeys: [{ ...KEY_A, dumpRetentionSeconds: undefined }],
    upstreams: [upstream],
  }));

  assertEquals(result.status, 200);
  assertEquals((await repo.apiKeys.listIncludingDeleted())[0].dumpRetentionSeconds, null);
  assertEquals((await repo.upstreams.list())[0].disabledPublicModelIds, []);
  assertEquals((await repo.upstreams.list())[0].modelPrefix, null);
});

test('positive-integer import fields preserve Number.isInteger semantics', async () => {
  const { app, repo } = setup();
  const beyondSafeInteger = Number.MAX_SAFE_INTEGER + 1;
  const result = await doImport(app, 'replace', latestImportData({
    users: [SEED_ADMIN, { ...USER_BOB, id: beyondSafeInteger }],
    apiKeys: [{ ...KEY_A, userId: beyondSafeInteger }],
    proxies: [{ id: 'p1', name: 'Proxy', url: HTTP_PROXY_URL, dial_timeout_seconds: beyondSafeInteger }],
  }));

  assertEquals(result.status, 200);
  assertEquals((await repo.apiKeys.listIncludingDeleted())[0].userId, beyondSafeInteger);
  assertEquals((await repo.proxies.list())[0].dialTimeoutSeconds, beyondSafeInteger);
});

test('import reports the earliest duplicate before later malformed records', async () => {
  const { app } = setup();
  const duplicateUser = await doImport(app, 'replace', latestImportData({
    users: [SEED_ADMIN, { ...USER_BOB, id: SEED_ADMIN.id }, { ...USER_BOB, deletedAt: 42 }],
  }));
  const duplicateMetric = await doImport(app, 'replace', latestImportData({
    usage: [{
      ...USAGE_1,
      metrics: [
        { metric: 'input_tokens', quantity: '1', unitPrice: null },
        { metric: 'input_tokens', quantity: '2', unitPrice: null },
        { metric: 'output_tokens', quantity: -1, unitPrice: null },
      ],
    }],
  }));
  const duplicateBucket = await doImport(app, 'replace', latestImportData({
    performanceIncluded: true,
    performance: [{
      ...PERFORMANCE_1,
      buckets: [
        { metric: 'ttft_ms', lower: 0, upper: 1_000, count: 1 },
        { metric: 'ttft_ms', lower: 0, upper: 1_000, count: 1 },
        { metric: 'tpot_us', lower: -1, upper: null, count: 1 },
      ],
    }],
  }));

  assertEquals(duplicateUser.body.error, 'invalid users at index 1: duplicate user id 1');
  assertEquals(duplicateMetric.body.error, 'invalid usage at index 0: duplicate usage metric: input_tokens');
  assertEquals(duplicateBucket.body.error, 'invalid performance record at index 0: duplicate bucket entry for {metric: ttft_ms, lower: 0}');
});

test('import preserves staged intra-record error precedence', async () => {
  const { app } = setup();
  const badUpstream = await doImport(app, 'replace', latestImportData({
    upstreams: [{ ...upstreamRecordToFullJson(CUSTOM_UPSTREAM), kind: 'invalid', id: '' }],
  }));
  const badApiKey = await doImport(app, 'replace', latestImportData({
    apiKeys: [{ ...KEY_A, upstreamIds: {}, id: '' }],
  }));
  const badApiKeyConstruction = await doImport(app, 'replace', latestImportData({
    apiKeys: [{ ...KEY_A, id: '', lastUsedAt: '' }],
  }));
  const duplicateMalformedUser = await doImport(app, 'replace', latestImportData({
    users: [SEED_ADMIN, { ...USER_BOB, id: SEED_ADMIN.id, username: 'bad username' }],
  }));
  const badUserConstruction = await doImport(app, 'replace', latestImportData({
    users: [SEED_ADMIN, { ...USER_BOB, deletedAt: 42, createdAt: '' }],
  }));
  const badUsage = await doImport(app, 'replace', latestImportData({
    usage: [{ ...USAGE_1, requests: -1, pricingSelector: null }],
  }));
  const badPerformance = await doImport(app, 'replace', latestImportData({
    performanceIncluded: true,
    performance: [{ ...PERFORMANCE_1, requests: PERFORMANCE_1.requests + 1, buckets: [null] }],
  }));

  assertEquals(badUpstream.body.error, `invalid upstreams at index 0: kind must be one of ${ALL_PROVIDER_KINDS.join(', ')}`);
  assertEquals(badApiKey.body.error, 'invalid apiKeys at index 0: upstream_ids must be null or an array of upstream ids');
  assertEquals(badApiKeyConstruction.body.error, 'invalid apiKeys at index 0: id must be a non-empty string');
  assertEquals(duplicateMalformedUser.body.error, 'invalid users at index 1: duplicate user id 1');
  assertEquals(badUserConstruction.body.error, 'invalid users at index 1: deletedAt must be null or an ISO string');
  assertEquals(badUsage.body.error, 'invalid usage at index 0: record has invalid usage fields');
  assertEquals(badPerformance.body.error, 'invalid performance record at index 0: ttftSamplesOk + errorsWithOutput + errorsNoOutput + neutral must equal requests');
});

test('import preserves collection-specific array-record boundaries', async () => {
  const { app } = setup();
  const upstream = await doImport(app, 'replace', latestImportData({ upstreams: [[]] }));
  const apiKey = await doImport(app, 'replace', latestImportData({ apiKeys: [[]] }));
  const usage = await doImport(app, 'replace', latestImportData({ usage: [[]] }));
  const searchUsage = await doImport(app, 'replace', latestImportData({ searchUsage: [[]] }));
  const performance = await doImport(app, 'replace', latestImportData({ performanceIncluded: true, performance: [[]] }));
  const bucket = await doImport(app, 'replace', latestImportData({
    performanceIncluded: true,
    performance: [{ ...PERFORMANCE_1, buckets: [[]] }],
  }));

  assertEquals(upstream.body.error, 'invalid upstreams at index 0: record must be an object');
  assertEquals(apiKey.body.error, 'invalid apiKeys at index 0: record must be an object');
  assertEquals(usage.body.error, 'invalid usage at index 0: record must be an object');
  assertEquals(searchUsage.body.error, 'invalid searchUsage at index 0: invalid provider');
  assertEquals(performance.body.error, 'invalid performance record at index 0: record fields are missing or malformed');
  assertEquals(bucket.body.error, 'invalid performance record at index 0: bucket metric/lower/upper/count fields are missing or malformed');
});

test('import rejects api key unique identity conflicts before mutating', async () => {
  const { app, repo } = setup();
  await repo.apiKeys.save(KEY_A);
  await repo.upstreams.save(CUSTOM_UPSTREAM);

  const duplicateRawKey = await doImport(app, 'replace', latestImportData({
    apiKeys: [KEY_B, { ...KEY_A, id: 'key-c', key: KEY_B.key }],
  }));
  const duplicateId = await doImport(app, 'replace', latestImportData({
    apiKeys: [KEY_B, { ...KEY_B, name: 'Duplicate Bob' }],
  }));
  const duplicateServerSecret = await doImport(app, 'replace', latestImportData({
    apiKeys: [KEY_B, { ...KEY_A, id: 'key-c', key: 'secret-c', serverSecret: KEY_B.serverSecret }],
  }));
  const mergeExistingRawKeyConflict = await doImport(app, 'merge', latestImportData({
    apiKeys: [{ ...KEY_B, key: KEY_A.key }],
  }));
  const mergeExistingServerSecretConflict = await doImport(app, 'merge', latestImportData({
    apiKeys: [{ ...KEY_B, serverSecret: KEY_A.serverSecret }],
  }));

  assertEquals(duplicateRawKey.status, 400);
  assertEquals(duplicateRawKey.body.error, 'invalid apiKeys: duplicate apiKeys raw key used by key-b and key-c');
  assertEquals(duplicateId.status, 400);
  assertEquals(duplicateId.body.error, 'invalid apiKeys: duplicate apiKeys id key-b at indexes 0 and 1');
  assertEquals(duplicateServerSecret.status, 400);
  assertEquals(duplicateServerSecret.body.error, 'invalid apiKeys: duplicate apiKeys server secret used by key-b and key-c');
  assertEquals(mergeExistingRawKeyConflict.status, 400);
  assertEquals(mergeExistingRawKeyConflict.body.error, 'invalid apiKeys: apiKeys raw key for key-b conflicts with existing api key key-a');
  assertEquals(mergeExistingServerSecretConflict.status, 400);
  assertEquals(mergeExistingServerSecretConflict.body.error, 'invalid apiKeys: apiKeys server secret for key-b conflicts with existing api key key-a');
  assertEquals(await repo.apiKeys.list(), [KEY_A]);
  assertEquals(await repo.upstreams.list(), [CUSTOM_UPSTREAM]);
});

test('import requires an exact lowercase hexadecimal serverSecret on every api key', async () => {
  const { app, repo } = setup();
  await repo.apiKeys.save(KEY_A);

  const malformed = [
    { ...KEY_B, serverSecret: undefined },
    { ...KEY_B, serverSecret: 'aa'.repeat(31) },
    { ...KEY_B, serverSecret: 'AA'.repeat(32) },
    { ...KEY_B, serverSecret: `${'aa'.repeat(31)}zz` },
  ];

  for (const key of malformed) {
    const result = await doImport(app, 'replace', latestImportData({ apiKeys: [key] }));
    assertEquals(result.status, 400);
    assertEquals(
      result.body.error,
      'invalid apiKeys at index 0: serverSecret must be exactly 64 lowercase hexadecimal characters',
    );
  }

  assertEquals(await repo.apiKeys.list(), [KEY_A]);
});

test('import preserves a positive dumpRetentionSeconds on api keys', async () => {
  const { app, repo } = setup();

  const result = await doImport(app, 'replace', latestImportData({
    apiKeys: [{ ...KEY_A, dumpRetentionSeconds: 3600 }],
  }));

  assertEquals(result.status, 200);
  const restored = await repo.apiKeys.findByRawKey(KEY_A.key);
  assertEquals(restored?.dumpRetentionSeconds, 3600);
});

test('v19 import preserves and validates Responses retention', async () => {
  const { app, repo } = setup();
  const retained = await doImport(app, 'replace', latestImportData({
    apiKeys: [{ ...KEY_A, responsesRetentionSeconds: 7 * 24 * 60 * 60 }],
  }));
  assertEquals(retained.status, 200);
  assertEquals((await repo.apiKeys.findByRawKey(KEY_A.key))?.responsesRetentionSeconds, 7 * 24 * 60 * 60);

  for (const value of [-1, 1, 3600, 86_401, 315_360_001, 86_400.5]) {
    const invalid = await doImport(app, 'replace', latestImportData({
      apiKeys: [{ ...KEY_A, responsesRetentionSeconds: value }],
    }));
    assertEquals(invalid.status, 400);
    assertEquals(String(invalid.body.error).includes('responsesRetentionSeconds must be 0 or a whole-day integer'), true);
  }
});

test('import rejects api keys whose dumpRetentionSeconds is out of range', async () => {
  const { app, repo } = setup();
  await repo.apiKeys.save(KEY_A);

  const zero = await doImport(app, 'replace', latestImportData({
    apiKeys: [{ ...KEY_A, dumpRetentionSeconds: 0 }],
  }));
  const negative = await doImport(app, 'replace', latestImportData({
    apiKeys: [{ ...KEY_A, dumpRetentionSeconds: -1 }],
  }));
  const tooLarge = await doImport(app, 'replace', latestImportData({
    apiKeys: [{ ...KEY_A, dumpRetentionSeconds: 400_000_000 }],
  }));

  for (const result of [zero, negative, tooLarge]) {
    assertEquals(result.status, 400);
    assertEquals(String(result.body.error).includes('dumpRetentionSeconds must be null or a positive integer'), true);
  }
  // Nothing was mutated — the validator runs before any write.
  assertEquals(await repo.apiKeys.list(), [KEY_A]);
});

test('import rejects legacy provider-prefixed upstream identities before mutating', async () => {
  const { app, repo } = setup();
  await repo.apiKeys.save(KEY_A);
  await repo.upstreams.save(CUSTOM_UPSTREAM);

  const legacyUpstreamId = await doImport(app, 'replace', latestImportData({
    upstreams: [{ ...upstreamRecordToFullJson(CUSTOM_UPSTREAM), id: 'openai:up_custom_a' }],
  }));
  const legacyUsageUpstream = await doImport(app, 'replace', latestImportData({
    usage: [{ ...USAGE_1, upstream: 'copilot:1' }],
  }));
  const legacyPerformanceUpstream = await doImport(app, 'replace', latestImportData({
    performanceIncluded: true,
    performance: [{ ...PERFORMANCE_1, upstream: 'copilot:1' }],
  }));

  assertEquals(legacyUpstreamId.status, 400);
  assertEquals(legacyUpstreamId.body.error, 'invalid upstreams at index 0: id must use a raw upstream id, not a legacy provider-prefixed identity');
  assertEquals(legacyUsageUpstream.status, 400);
  assertEquals(legacyUsageUpstream.body.error, 'invalid usage at index 0: upstream must use a raw upstream id, not a legacy provider-prefixed identity');
  assertEquals(legacyPerformanceUpstream.status, 400);
  assertEquals(legacyPerformanceUpstream.body.error, 'invalid performance record at index 0: record fields are missing or malformed');
  assertEquals(await repo.apiKeys.list(), [KEY_A]);
  assertEquals(await repo.upstreams.list(), [CUSTOM_UPSTREAM]);
});

test('import rejects legacy enabled_fixes payloads before mutating', async () => {
  const { app, repo } = setup();
  await repo.apiKeys.save(KEY_A);
  await repo.upstreams.save(CUSTOM_UPSTREAM);

  const { flag_overrides: _flagOverrides, ...customWithoutFlagOverrides } = upstreamRecordToFullJson(CUSTOM_UPSTREAM);
  const legacyEnabledFixes = await doImport(app, 'replace', latestImportData({
    upstreams: [{ ...customWithoutFlagOverrides, enabled_fixes: ['messages-web-search-shim'] }],
  }));
  const legacyAlongsideNew = await doImport(app, 'replace', latestImportData({
    upstreams: [{ ...upstreamRecordToFullJson(CUSTOM_UPSTREAM), enabled_fixes: [] }],
  }));

  assertEquals(legacyEnabledFixes.status, 400);
  assertEquals(String(legacyEnabledFixes.body.error).includes("legacy 'enabled_fixes' field is no longer supported"), true);
  assertEquals(legacyAlongsideNew.status, 400);
  assertEquals(String(legacyAlongsideNew.body.error).includes("legacy 'enabled_fixes' field is no longer supported"), true);
  assertEquals(await repo.apiKeys.list(), [KEY_A]);
  assertEquals(await repo.upstreams.list(), [CUSTOM_UPSTREAM]);
});

test('import rejects missing latest-v19 arrays before clearing existing data', async () => {
  const { app, repo } = setup();
  await repo.apiKeys.save(KEY_A);
  await repo.upstreams.save(CUSTOM_UPSTREAM);
  await repo.usage.set(USAGE_1);
  await repo.webSearchUsage.set(WEB_SEARCH_USAGE_1);

  const missingApiKeys = await doImport(app, 'replace', latestImportData({ apiKeys: undefined }));
  const missingUsage = await doImport(app, 'replace', latestImportData({ usage: undefined }));
  const missingWebSearchUsage = await doImport(app, 'replace', latestImportData({ searchUsage: undefined }));

  assertEquals(missingApiKeys.status, 400);
  assertEquals(missingApiKeys.body.error, 'invalid apiKeys: apiKeys must be an array');
  assertEquals(missingUsage.status, 400);
  assertEquals(missingUsage.body.error, 'invalid usage: usage must be an array');
  assertEquals(missingWebSearchUsage.status, 400);
  assertEquals(missingWebSearchUsage.body.error, 'invalid searchUsage: searchUsage must be an array');
  assertEquals(await repo.apiKeys.list(), [KEY_A]);
  assertEquals(await repo.upstreams.list(), [CUSTOM_UPSTREAM]);
  assertEquals(await repo.usage.listAll(), [USAGE_1]);
  assertEquals(await repo.webSearchUsage.listAll(), [WEB_SEARCH_USAGE_1]);
});

test('import validates mode and data before mutating', async () => {
  const { app } = setup();

  const invalidMode = await doImport(app, 'invalid', {}, 19);
  const missingData = await app.request('/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'replace', version: 19 }),
  });
  const missingUpstreams = await doImport(app, 'merge', {}, 19);
  const emptyMerge = await doImport(app, 'merge', latestImportData(), 19);

  assertEquals(invalidMode.status, 400);
  assertEquals(invalidMode.body.error, "mode must be 'merge' or 'replace'");
  assertEquals(missingData.status, 400);
  assertEquals(((await missingData.json()) as { error: string }).error, 'data is required');
  assertEquals(missingUpstreams.status, 400);
  assertEquals(missingUpstreams.body.error, 'invalid apiKeys: apiKeys must be an array');
  assertEquals(emptyMerge.status, 200);
  assertEquals(emptyMerge.body.imported, { users: 1, apiKeys: 0, upstreams: 0, proxies: 0, usage: 0, searchUsage: 0, performance: 0 });
});

const HTTP_PROXY_URL = 'http://198.51.100.20:3128';
const SOCKS_PROXY_URL = 'socks5://user:pass@198.51.100.10:1080';

test('export includes proxies with full credential URIs and round-trips through import', async () => {
  const { app, repo } = setup();
  await repo.proxies.save({ id: 'p_socks', name: 'SOCKS', url: SOCKS_PROXY_URL, dialTimeoutSeconds: 45 });
  await repo.proxies.save({ id: 'p_http', name: 'HTTP', url: HTTP_PROXY_URL, dialTimeoutSeconds: null });
  const upstreamWithFallback: UpstreamRecord = { ...CUSTOM_UPSTREAM, proxyFallbackList: [{ id: 'p_socks' }, { id: 'direct_connect' }, { id: 'p_http' }, { id: 'direct_fetch' }] };
  await repo.upstreams.save(upstreamWithFallback);

  const exported = await doExport(app);

  assertEquals(exported.data.proxies, [
    { id: 'p_socks', name: 'SOCKS', url: SOCKS_PROXY_URL, dial_timeout_seconds: 45 },
    { id: 'p_http', name: 'HTTP', url: HTTP_PROXY_URL, dial_timeout_seconds: null },
  ]);

  const fresh = new InMemoryRepo();
  initRepo(fresh);
  const importApp = new Hono();
  importApp.post('/import', zValidator('json', importBody), importData);
  const result = await doImport(importApp, 'replace', exported.data);
  assertEquals(result.status, 200);
  assertEquals(result.body.imported.proxies, 2);

  const restored = await fresh.proxies.list();
  assertEquals(restored.map(p => ({ id: p.id, name: p.name, url: p.url, dialTimeoutSeconds: p.dialTimeoutSeconds })).sort((a, b) => a.id.localeCompare(b.id)), [
    { id: 'p_http', name: 'HTTP', url: HTTP_PROXY_URL, dialTimeoutSeconds: null },
    { id: 'p_socks', name: 'SOCKS', url: SOCKS_PROXY_URL, dialTimeoutSeconds: 45 },
  ]);

  const restoredUpstream = await fresh.upstreams.getById(upstreamWithFallback.id);
  assertEquals(restoredUpstream?.proxyFallbackList, [{ id: 'p_socks' }, { id: 'direct_connect' }, { id: 'p_http' }, { id: 'direct_fetch' }]);
});

test('import rejects proxy rows that collide with built-in direct transports', async () => {
  const { app } = setup();

  const result = await doImport(app, 'replace', latestImportData({
    proxies: [{ id: 'direct_connect', name: 'Collision', url: HTTP_PROXY_URL, dial_timeout_seconds: null }],
  }));

  assertEquals(result.status, 400);
  assertEquals(String(result.body.error).includes('reserved direct-transport sentinel'), true);
});

test('import in replace mode rejects an upstream fallback reference that does not resolve to an imported proxy', async () => {
  const { app, repo } = setup();
  await repo.upstreams.save(CUSTOM_UPSTREAM);

  const result = await doImport(app, 'replace', latestImportData({
    upstreams: [{ ...upstreamRecordToFullJson(CUSTOM_UPSTREAM), proxy_fallback_list: [{ id: 'p_missing' }, { id: 'direct_fetch' }] }],
    proxies: [],
  }));

  assertEquals(result.status, 400);
  assertEquals(result.body.error, `invalid upstreams: upstream ${CUSTOM_UPSTREAM.id} references unknown proxy p_missing`);
  assertEquals(await repo.upstreams.list(), [CUSTOM_UPSTREAM]);
});

test('import in merge mode accepts an upstream fallback reference that resolves to an existing local proxy', async () => {
  const { app, repo } = setup();
  await repo.proxies.save({ id: 'p_local', name: 'Local', url: HTTP_PROXY_URL, dialTimeoutSeconds: null });

  // The imported payload carries no proxies of its own, only an upstream that
  // references the destination's existing 'p_local'. Merge mode keeps the
  // local proxies table, so this is a legitimate reference that must not be
  // rejected as dangling.
  const result = await doImport(app, 'merge', latestImportData({
    upstreams: [{ ...upstreamRecordToFullJson(CUSTOM_UPSTREAM), proxy_fallback_list: [{ id: 'p_local' }, { id: 'direct_fetch' }] }],
    proxies: [],
  }));

  assertEquals(result.status, 200);
  assertEquals(result.body.imported.upstreams, 1);
  const restored = await repo.upstreams.getById(CUSTOM_UPSTREAM.id);
  assertEquals(restored?.proxyFallbackList, [{ id: 'p_local' }, { id: 'direct_fetch' }]);
});

test('import in merge mode rejects an upstream fallback reference that resolves to neither an imported nor an existing proxy', async () => {
  const { app, repo } = setup();
  await repo.proxies.save({ id: 'p_local', name: 'Local', url: HTTP_PROXY_URL, dialTimeoutSeconds: null });

  const result = await doImport(app, 'merge', latestImportData({
    upstreams: [{ ...upstreamRecordToFullJson(CUSTOM_UPSTREAM), proxy_fallback_list: [{ id: 'p_phantom' }] }],
    proxies: [],
  }));

  assertEquals(result.status, 400);
  assertEquals(result.body.error, `invalid upstreams: upstream ${CUSTOM_UPSTREAM.id} references unknown proxy p_phantom`);
});

test('import rejects a proxy whose url does not parse', async () => {
  const { app } = setup();

  const result = await doImport(app, 'replace', latestImportData({
    proxies: [{ id: 'p_bad', name: 'Bad', url: 'gibberish', dial_timeout_seconds: null }],
  }));

  assertEquals(result.status, 400);
  assertEquals(String(result.body.error).startsWith('invalid proxies at index 0: url did not parse:'), true);
});

test('import upserts proxies on id collision (last-writer-wins on name / url / timeout)', async () => {
  const { app, repo } = setup();
  await repo.proxies.save({ id: 'p1', name: 'Original', url: HTTP_PROXY_URL, dialTimeoutSeconds: null });

  const result = await doImport(app, 'merge', latestImportData({
    proxies: [{ id: 'p1', name: 'Renamed', url: SOCKS_PROXY_URL, dial_timeout_seconds: 90 }],
  }));

  assertEquals(result.status, 200);
  assertEquals(result.body.imported.proxies, 1);

  const after = await repo.proxies.getById('p1');
  assertEquals(after?.name, 'Renamed');
  assertEquals(after?.url, SOCKS_PROXY_URL);
  assertEquals(after?.dialTimeoutSeconds, 90);
});

test('import replace wipes proxy_upstream_backoffs alongside the proxies it cools down', async () => {
  // Backoff rows survive only as long as the proxy_id they reference is real;
  // a replace import that brings in a fresh proxy with the same id as a wiped
  // one would otherwise have its first dials short-circuited by a stale
  // cool-down row from the prior catalog.
  const { app, repo } = setup();
  await repo.proxies.save({ id: 'p_old', name: 'Old', url: HTTP_PROXY_URL, dialTimeoutSeconds: null });
  await repo.upstreams.save(CUSTOM_UPSTREAM);
  await repo.proxyBackoffs.recordDialFailure('p_old', CUSTOM_UPSTREAM.id, 'transport reset');
  assertEquals((await repo.proxyBackoffs.listAll()).length, 1);

  const result = await doImport(app, 'replace', latestImportData({
    proxies: [{ id: 'p_old', name: 'New', url: SOCKS_PROXY_URL, dial_timeout_seconds: null }],
    upstreams: [upstreamRecordToFullJson(CUSTOM_UPSTREAM)],
  }));

  assertEquals(result.status, 200);
  assertEquals(await repo.proxyBackoffs.listAll(), []);
});

test('v19 export/import round-trips users and per-key user_id', async () => {
  const { app, repo } = setup();
  await repo.users.save(SEED_ADMIN);
  await repo.users.save(USER_BOB);
  await repo.apiKeys.save(KEY_A);
  await repo.apiKeys.save({ ...KEY_B, userId: USER_BOB.id });

  const exportResult = await doExport(app);
  assertEquals(exportResult.version, 19);
  assertEquals(exportResult.data.users.map((u: any) => u.id).sort(), [SEED_ADMIN.id, USER_BOB.id]);

  const result = await doImport(app, 'replace', exportResult.data, 19);
  assertEquals(result.status, 200);
  assertEquals(result.body.imported.users, 2);
  assertEquals(result.body.imported.apiKeys, 2);

  const restoredUsers = await repo.users.listIncludingDeleted();
  assertEquals(restoredUsers.find(u => u.id === USER_BOB.id)?.passwordHash, USER_BOB.passwordHash);
  const restoredKey = await repo.apiKeys.findByRawKey(KEY_B.key);
  assertEquals(restoredKey?.userId, USER_BOB.id);
});

test('v19 import rejects api_keys whose user_id does not appear in the payload', async () => {
  const { app, repo } = setup();
  await repo.users.save(SEED_ADMIN);

  const result = await doImport(app, 'replace', {
    users: [SEED_ADMIN],
    apiKeys: [{ ...KEY_A, userId: 99 }],
    upstreams: [],
    usage: [],
    searchUsage: [],
    performanceIncluded: false,
    searchConfig: DEFAULT_WEB_SEARCH_CONFIG,
  }, 19);

  assertEquals(result.status, 400);
  assertEquals(result.body.error, 'invalid apiKeys at index 0: user_id 99 does not match any user in the payload');
});

test('v19 import rejects malformed users (bad username, bad password_hash)', async () => {
  const { app } = setup();

  const badUsername = await doImport(app, 'replace', {
    users: [{ ...USER_BOB, username: 'has space' }],
    apiKeys: [],
    upstreams: [],
    usage: [],
    searchUsage: [],
    performanceIncluded: false,
    searchConfig: DEFAULT_WEB_SEARCH_CONFIG,
  }, 19);
  assertEquals(badUsername.status, 400);
  assertEquals(String(badUsername.body.error).startsWith('invalid users at index 0:'), true);

  const badHash = await doImport(app, 'replace', {
    users: [{ ...USER_BOB, passwordHash: 'argon2$10000$$' }],
    apiKeys: [],
    upstreams: [],
    usage: [],
    searchUsage: [],
    performanceIncluded: false,
    searchConfig: DEFAULT_WEB_SEARCH_CONFIG,
  }, 19);
  assertEquals(badHash.status, 400);
  assertEquals(String(badHash.body.error).includes('passwordHash'), true);
});

test('import rejects a pre-accounts v3 export instead of coercing its legacy api_keys', async () => {
  const { app, repo } = setup();
  await repo.users.save(SEED_ADMIN);
  await repo.apiKeys.save(KEY_A);

  // A real legacy v3 export stamps version 3 and carries no userId on its keys.
  const { userId: _userId, ...legacyKey } = KEY_B;
  const result = await doImport(app, 'replace', {
    apiKeys: [legacyKey],
    upstreams: [],
    usage: [],
    searchUsage: [],
    performanceIncluded: false,
    searchConfig: DEFAULT_WEB_SEARCH_CONFIG,
  }, 3);

  assertEquals(result.status, 400);
  assertEquals(String(result.body.error).includes('version must be 19'), true);
  // Rejected at the version gate, before touching any data.
  assertEquals(await repo.apiKeys.list(), [KEY_A]);
  assertEquals((await repo.users.list()).map(u => u.id), [SEED_ADMIN.id]);
});

test('replace-mode import clears sessions before writing users', async () => {
  const { app, repo } = setup();
  await repo.users.save(SEED_ADMIN);
  await repo.users.save(USER_BOB);
  await repo.sessions.create(SEED_ADMIN.id);
  await repo.sessions.create(USER_BOB.id);

  const result = await doImport(app, 'replace', {
    users: [SEED_ADMIN, USER_BOB],
    apiKeys: [],
    upstreams: [],
    usage: [],
    searchUsage: [],
    performanceIncluded: false,
    searchConfig: DEFAULT_WEB_SEARCH_CONFIG,
  }, 19);

  assertEquals(result.status, 200);
  // No public listAll on sessions; create a fresh session and check the
  // deletion happened by directly calling deleteByUserId — both should report 0.
  assertEquals(await repo.sessions.deleteByUserId(SEED_ADMIN.id), 0);
  assertEquals(await repo.sessions.deleteByUserId(USER_BOB.id), 0);
});

test('v19 import rejects users[i].upstreamIds === undefined', async () => {
  const { app } = setup();
  const result = await doImport(app, 'replace', {
    users: [SEED_ADMIN, { ...USER_BOB, upstreamIds: undefined }],
    apiKeys: [],
    upstreams: [],
    usage: [],
    searchUsage: [],
    performanceIncluded: false,
    searchConfig: DEFAULT_WEB_SEARCH_CONFIG,
  }, 19);
  assertEquals(result.status, 400);
  expect(result.body.error).toMatch(/upstreamIds/);
});

test('v19 import rejects users[i].deletedAt of non-string non-null type', async () => {
  const { app } = setup();
  const result = await doImport(app, 'replace', {
    users: [SEED_ADMIN, { ...USER_BOB, deletedAt: 42 }],
    apiKeys: [],
    upstreams: [],
    usage: [],
    searchUsage: [],
    performanceIncluded: false,
    searchConfig: DEFAULT_WEB_SEARCH_CONFIG,
  }, 19);
  assertEquals(result.status, 400);
  expect(result.body.error).toMatch(/deletedAt/);
});

test('v19 replace import refuses payload missing user 1', async () => {
  const { app } = setup();
  const result = await doImport(app, 'replace', {
    users: [USER_BOB],
    apiKeys: [],
    upstreams: [],
    usage: [],
    searchUsage: [],
    performanceIncluded: false,
    searchConfig: DEFAULT_WEB_SEARCH_CONFIG,
  }, 19);
  assertEquals(result.status, 400);
  expect(result.body.error).toMatch(/user 1/);
});

test('a full v19 export re-imports verbatim — the export→import round trip is closed', async () => {
  const { app, repo } = setup();
  await repo.users.save(SEED_ADMIN);
  await repo.users.save(USER_BOB);
  await repo.apiKeys.save(KEY_A);
  await repo.apiKeys.save({ ...KEY_B, userId: USER_BOB.id });
  await repo.upstreams.save(COPILOT_UPSTREAM);
  await repo.upstreams.save(CUSTOM_UPSTREAM);
  await repo.upstreams.save(AZURE_UPSTREAM);
  await repo.upstreams.save(CODEX_UPSTREAM);
  await repo.usage.set(USAGE_1);
  await repo.usage.set(USAGE_2);
  await repo.webSearchUsage.set(WEB_SEARCH_USAGE_1);
  await repo.webSearchUsage.set(WEB_SEARCH_USAGE_2);
  await repo.performance.set(PERFORMANCE_1);
  await repo.performance.set(PERFORMANCE_2);
  const config = {
    provider: 'tavily' as const,
    tavily: { apiKey: 'tk' },
    microsoftWebIq: { apiKey: '' },
    jina: { apiKey: '' },
    passthroughOpenAiSearch: { enabled: false, upstreamId: '', model: '' },
  };
  await repo.webSearchConfig.save(config);

  const exported = await doExport(app, true);
  assertEquals(exported.version, 19);

  // Replace-import the export's own `data`, verbatim. If the export emits any
  // shape the import parser rejects, this 400s — the round trip is the
  // invariant, so this test fails the moment the two sides drift.
  const result = await doImport(app, 'replace', exported.data, 19);
  assertEquals(result.status, 200);
  assertEquals(result.body.imported, { users: 2, apiKeys: 2, upstreams: 4, proxies: 0, usage: 2, searchUsage: 2, performance: 2 });

  // Spot-check fidelity across collection types (order-independent).
  assertEquals((await repo.upstreams.list()).find(u => u.id === 'up_codex_a')?.state, CODEX_UPSTREAM.state);
  assertEquals((await repo.users.listIncludingDeleted()).find(u => u.id === USER_BOB.id), USER_BOB);
  assertEquals((await repo.apiKeys.findByRawKey(KEY_B.key))?.userId, USER_BOB.id);
  const restoredKeyA = await repo.apiKeys.findByRawKey(KEY_A.key);
  if (restoredKeyA === null) throw new Error('restored key A missing');
  assertEquals((await repo.usage.listAll()).find(u => u.keyId === restoredKeyA.id && u.hour === USAGE_1.hour), { ...USAGE_1, keyId: restoredKeyA.id });
  assertEquals((await repo.performance.listAll()).find(p => p.keyId === restoredKeyA.id && p.hour === PERFORMANCE_1.hour), { ...PERFORMANCE_1, keyId: restoredKeyA.id });
  assertEquals(await repo.webSearchConfig.get(), config);
});

test('any data bearing a historical version is rejected on the version gate, before mutating', async () => {
  const { app, repo } = setup();
  await repo.users.save(SEED_ADMIN);
  await repo.apiKeys.save(KEY_A);
  await repo.upstreams.save(CUSTOM_UPSTREAM);

  // A perfectly well-formed current-version payload — only the version stamp
  // is historical. It must still be refused on the version alone.
  const wellFormed = {
    users: [SEED_ADMIN],
    apiKeys: [KEY_A],
    upstreams: [upstreamRecordToFullJson(CUSTOM_UPSTREAM)],
    usage: [],
    searchUsage: [],
    performanceIncluded: false,
    searchConfig: DEFAULT_WEB_SEARCH_CONFIG,
  };

  for (const version of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]) {
    const result = await doImport(app, 'replace', wellFormed, version);
    assertEquals(result.status, 400);
    assertEquals(String(result.body.error).includes('version must be 19'), true);
  }

  // Nothing was touched — the version gate runs before any delete or write.
  assertEquals(await repo.apiKeys.list(), [KEY_A]);
  assertEquals((await repo.upstreams.list()).map(u => u.id), ['up_custom_a']);
});

test('replace-mode import cuts SSE subscribers for every pre-existing dump key', async () => {
  const { app, repo } = setup();
  await repo.apiKeys.save({ ...KEY_A, dumpRetentionSeconds: 3600 });
  await repo.apiKeys.save({ ...KEY_B, dumpRetentionSeconds: 1800 });
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);

  const result = await doImport(app, 'replace', latestImportData({
    apiKeys: [{ ...KEY_A, dumpRetentionSeconds: 3600 }],
  }));
  assertEquals(result.status, 200);
  assertEquals(stubs.closedChannels.some(c => c.keyId === KEY_A.id), true);
  assertEquals(stubs.closedChannels.some(c => c.keyId === KEY_B.id), true);
});

test('replace-mode import succeeds when the broker close hook throws', async () => {
  const { app, repo } = setup();
  await repo.apiKeys.save({ ...KEY_A, dumpRetentionSeconds: 3600 });
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);
  stubs.failOn('closeChannel', new Error('broker down'));

  const result = await doImport(app, 'replace', latestImportData({
    apiKeys: [{ ...KEY_A, dumpRetentionSeconds: 3600 }],
  }));
  assertEquals(result.status, 200);
});

test('merge-mode import flipping retention to null closes the channel', async () => {
  const { app, repo } = setup();
  await repo.apiKeys.save({ ...KEY_A, dumpRetentionSeconds: 3600 });
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);

  const result = await doImport(app, 'merge', latestImportData({
    apiKeys: [{ ...KEY_A, dumpRetentionSeconds: null }],
  }));
  assertEquals(result.status, 200);
  assertEquals(stubs.closedChannels.some(c => c.keyId === KEY_A.id), true);
});

test('merge-mode import shrinking retention succeeds without closing the channel', async () => {
  const { app, repo } = setup();
  await repo.apiKeys.save({ ...KEY_A, dumpRetentionSeconds: 7200 });
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);

  const result = await doImport(app, 'merge', latestImportData({
    apiKeys: [{ ...KEY_A, dumpRetentionSeconds: 1800 }],
  }));
  assertEquals(result.status, 200);
  assertEquals(stubs.closedChannels.some(c => c.keyId === KEY_A.id), false);
});

test('merge-mode retention transition tolerates dump-broker failure', async () => {
  const { app, repo } = setup();
  await repo.apiKeys.save({ ...KEY_A, dumpRetentionSeconds: 3600 });
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);
  stubs.failOn('closeChannel', new Error('broker down'));

  const result = await doImport(app, 'merge', latestImportData({
    apiKeys: [{ ...KEY_A, dumpRetentionSeconds: null }],
  }));
  assertEquals(result.status, 200);
});
