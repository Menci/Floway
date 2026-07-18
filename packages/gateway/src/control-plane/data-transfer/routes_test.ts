import { Hono } from 'hono';
import { expect, test, vi } from 'vitest';

// The import handler warms the SWR models cache for every saved upstream by
// calling each provider's getProvidedModels, which for Copilot / Custom would
// make real upstream HTTP requests the test sandbox cannot serve and hang
// until the vitest timeout. Stub the cache layer to a no-op so the import
// path's own behavior (upserts, identity validation, etc.) is what the tests
// exercise — the warm itself has dedicated coverage in models-cache_test.ts.
vi.mock('../../data-plane/providers/models-cache.ts', () => ({
  fetchUpstreamModelsCached: () => Promise.resolve([]),
}));

import { exportData, importData } from './routes.ts';
import { DEFAULT_SEARCH_CONFIG } from '../../data-plane/tools/web-search/search-config.ts';
import { initDumpBroker, initDumpStore } from '../../dump/registry.ts';
import { installDumpStubs } from '../../dump/test-fixtures.ts';
import { zValidator } from '../../middleware/zod-validator.ts';
import { initRepo } from '../../repo/index.ts';
import { InMemoryRepo } from '../../repo/memory.ts';
import type { ApiKey, PerformanceTelemetryRecord, SearchUsageRecord, StoredResponsesItem, UsageRecord, User } from '../../repo/types.ts';
import { exportQuery, importBody } from '../schemas.ts';
import { upstreamRecordToFullJson } from '../upstreams/serialize.ts';
import type { UpstreamRecord } from '@floway-dev/provider';
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
};

const SEED_ADMIN: User = {
  id: 1,
  username: 'admin',
  passwordHash: null,
  isAdmin: true,
  upstreamIds: null,
  canViewGlobalTelemetry: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  deletedAt: null,
};

const USER_BOB: User = {
  id: 2,
  username: 'bob',
  passwordHash: 'pbkdf2-sha256$600000$c2FsdA==$aGFzaA==',
  isAdmin: false,
  upstreamIds: null,
  canViewGlobalTelemetry: false,
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
  color: null,
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
  color: null,
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
  color: null,
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
  color: null,
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
  tokens: { input: 1000, output: 500, input_cache_read: 120, input_cache_write: 80 },
  rates: null,
};

const USAGE_2: UsageRecord = {
  keyId: 'key-b',
  model: 'gpt-public',
  upstream: 'up_azure_a',
  modelKey: 'gpt-prod',
  hour: '2026-01-01T11',
  pricingSelector: {},
  requests: 3,
  tokens: { input: 2000, output: 800, input_cache_read: 200, input_cache_write: 50 },
  rates: null,
};

const SEARCH_USAGE_1: SearchUsageRecord = {
  provider: 'tavily',
  keyId: 'key-a',
  action: 'search',
  hour: '2026-01-01T10',
  requests: 2,
};

const SEARCH_USAGE_2: SearchUsageRecord = {
  provider: 'microsoft-grounding',
  keyId: 'key-b',
  action: 'fetch_page',
  hour: '2026-01-01T11',
  requests: 4,
};

const STORED_RESPONSES_ITEM: StoredResponsesItem = {
  id: 'msg_z1mVjw_0xVvS8c_KjD1sBkZk5qbdA',
  apiKeyId: 'key-a',
  itemType: 'message',
  contentHash: 'stored-content-hash',
  payload: { item: { type: 'message', id: 'msg_z1mVjw_0xVvS8c_KjD1sBkZk5qbdA', role: 'assistant', content: [] } },
  createdAt: 1_000,
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

const doImport = async (app: Hono, mode: string, data: unknown, version: unknown = 11) => {
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
  searchConfig: DEFAULT_SEARCH_CONFIG,
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

test('export emits the v11 envelope with users and upstreams', async () => {
  const { app, repo } = setup();
  await repo.users.save(SEED_ADMIN);

  const result = await doExport(app);

  assertEquals(result.version, 11);
  assertEquals(typeof result.exportedAt, 'string');
  assertEquals(result.data.users, [SEED_ADMIN]);
  assertEquals(result.data.apiKeys, []);
  assertEquals(result.data.upstreams, []);
  assertEquals(result.data.proxies, []);
  assertEquals(result.data.usage, []);
  assertEquals(result.data.searchUsage, []);
  assertEquals(result.data.performanceIncluded, false);
  assertEquals(hasOwn(result.data, 'performance'), false);
  assertEquals(result.data.searchConfig, DEFAULT_SEARCH_CONFIG);
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
  await repo.searchUsage.set(SEARCH_USAGE_1);
  await repo.performance.set(PERFORMANCE_1);
  await repo.searchConfig.save({
    provider: 'tavily',
    tavily: { apiKey: 'tvly-test' },
    microsoftGrounding: { apiKey: 'ms-test' },
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
  assertEquals(result.data.searchUsage, [SEARCH_USAGE_1]);
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

  const VERSION_ERROR = 'version must be 11 — older export formats are not supported; re-export from the current deployment';
  const previousV10 = await doImport(app, 'replace', latestImportData(), 10);
  const ancientVersion = await doImport(app, 'replace', { apiKeys: [] }, 1);
  const missingVersionResponse = await app.request('/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'replace', data: { apiKeys: [] } }),
  });
  const missingVersion = { status: missingVersionResponse.status, body: (await missingVersionResponse.json()) as Record<string, any> };

  assertEquals(previousV10.status, 400);
  assertEquals(previousV10.body.error, VERSION_ERROR);
  assertEquals(ancientVersion.status, 400);
  assertEquals(ancientVersion.body.error, VERSION_ERROR);
  assertEquals(missingVersion.status, 400);
  assertEquals(missingVersion.body.error, VERSION_ERROR);
  assertEquals(await repo.apiKeys.list(), [KEY_A]);
  assertEquals((await repo.upstreams.list()).map(upstream => upstream.id), ['up_custom_a']);
});

test('import replace writes upstreams and clears replaced collections', async () => {
  const { app, repo } = setup();
  await repo.apiKeys.save(KEY_A);
  await repo.upstreams.save(CUSTOM_UPSTREAM);
  await repo.usage.set(USAGE_1);
  await repo.searchUsage.set(SEARCH_USAGE_1);
  await repo.responsesItems.insertMany([STORED_RESPONSES_ITEM]);
  await repo.searchConfig.save({
    provider: 'tavily',
    tavily: { apiKey: 'old' },
    microsoftGrounding: { apiKey: '' },
    jina: { apiKey: '' },
    passthroughOpenAiSearch: { enabled: false, upstreamId: '', model: '' },
  });

  const result = await doImport(app, 'replace', {
    users: [SEED_ADMIN],
    apiKeys: [KEY_B],
    upstreams: [upstreamRecordToFullJson(AZURE_UPSTREAM)],
    usage: [USAGE_2],
    searchUsage: [SEARCH_USAGE_2],
    performanceIncluded: false,
    searchConfig: {
      provider: 'microsoft-grounding',
      tavily: { apiKey: '' },
      microsoftGrounding: { apiKey: 'ms-new' },
      jina: { apiKey: '' },
      passthroughOpenAiSearch: { enabled: false, upstreamId: '', model: '' },
    },
  });

  assertEquals(result.status, 200);
  assertEquals(result.body.imported, { users: 1, apiKeys: 1, upstreams: 1, proxies: 0, usage: 1, searchUsage: 1, performance: 0 });
  assertEquals(await repo.apiKeys.list(), [KEY_B]);
  assertEquals(await repo.upstreams.list(), [AZURE_UPSTREAM]);
  assertEquals(await repo.usage.listAll(), [USAGE_2]);
  assertEquals(await repo.searchUsage.listAll(), [SEARCH_USAGE_2]);
  assertEquals(await repo.responsesItems.lookupMany('key-a', [STORED_RESPONSES_ITEM.id]), []);
  assertEquals(await repo.searchConfig.get(), {
    provider: 'microsoft-grounding',
    tavily: { apiKey: '' },
    microsoftGrounding: { apiKey: 'ms-new' },
    jina: { apiKey: '' },
    passthroughOpenAiSearch: { enabled: false, upstreamId: '', model: '' },
  });
});

test('import merge upserts by repository key without clearing unrelated rows', async () => {
  const { app, repo } = setup();
  await repo.apiKeys.save(KEY_A);
  await repo.upstreams.save(CUSTOM_UPSTREAM);
  await repo.usage.set({ ...USAGE_1, requests: 10 });
  await repo.searchUsage.set({ ...SEARCH_USAGE_1, requests: 10 });

  const updatedCustom = { ...CUSTOM_UPSTREAM, name: 'Custom Updated', updatedAt: '2026-03-01T00:00:00.000Z' } satisfies UpstreamRecord;
  const result = await doImport(app, 'merge', latestImportData({
    apiKeys: [{ ...KEY_A, name: 'Alice Updated' }, KEY_B],
    upstreams: [upstreamRecordToFullJson(updatedCustom), upstreamRecordToFullJson(COPILOT_UPSTREAM)],
    usage: [USAGE_1],
    searchUsage: [SEARCH_USAGE_1],
  }));

  assertEquals(result.status, 200);
  assertEquals((await repo.apiKeys.list()).map(key => key.name), ['Alice Updated', 'Bob']);
  assertEquals((await repo.upstreams.list()).map(upstream => [upstream.id, upstream.name]), [
    ['up_copilot_a', 'GitHub Copilot (alice)'],
    ['up_custom_a', 'Custom Updated'],
  ]);
  assertEquals(await repo.usage.listAll(), [USAGE_1]);
  assertEquals(await repo.searchUsage.listAll(), [SEARCH_USAGE_1]);
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
    searchConfig: DEFAULT_SEARCH_CONFIG,
  });

  assertEquals(replace.status, 200);
  assertEquals(await repo.performance.listAll(), [PERFORMANCE_2]);
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
    searchConfig: DEFAULT_SEARCH_CONFIG,
  });

  assertEquals(result.status, 400);
  assertEquals(result.body.error, 'invalid upstreams: upstreams must be an array');
  assertEquals(await repo.apiKeys.list(), [KEY_A]);
  assertEquals(await repo.upstreams.list(), [CUSTOM_UPSTREAM]);
  assertEquals(await repo.usage.listAll(), [USAGE_1]);
});

test('codex upstreams export and import round-trip with state intact', async () => {
  const { app, repo } = setup();
  await repo.upstreams.save(CODEX_UPSTREAM);
  await repo.searchConfig.save(DEFAULT_SEARCH_CONFIG);

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
    searchConfig: DEFAULT_SEARCH_CONFIG,
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
    searchConfig: DEFAULT_SEARCH_CONFIG,
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
    searchConfig: DEFAULT_SEARCH_CONFIG,
  });
  assertEquals(result.status, 400);
  assertEquals(result.body.error.includes('unexpected key'), true);
});

test('import rejects negative historical unit prices with a dimension-specific error', async () => {
  const { app } = setup();
  const result = await doImport(app, 'replace', latestImportData({
    usage: [{ ...USAGE_2, rates: { input: -0.01, output: 15 } }],
  }));

  assertEquals(result.status, 400);
  assertEquals(result.body.error, 'invalid usage at index 0: rates.input must be a finite non-negative number');
});

test('v11 import requires exact usage token and rate maps', async () => {
  const { app } = setup();
  const missingTokens = await doImport(app, 'replace', latestImportData({
    usage: [{ ...USAGE_2, tokens: undefined }],
  }));
  const missingRates = await doImport(app, 'replace', latestImportData({
    usage: [{ ...USAGE_2, rates: undefined }],
  }));
  const unknownTokens = await doImport(app, 'replace', latestImportData({
    usage: [{ ...USAGE_2, tokens: { ...USAGE_2.tokens, imput: 1 } }],
  }));
  const unknownRates = await doImport(app, 'replace', latestImportData({
    usage: [{ ...USAGE_2, rates: { input: 2, ouput: 8 } }],
  }));

  assertEquals(missingTokens.body.error, 'invalid usage at index 0: tokens is required');
  assertEquals(missingRates.body.error, 'invalid usage at index 0: rates is required');
  assertEquals(unknownTokens.body.error, 'invalid usage at index 0: tokens has unknown dimensions: imput');
  assertEquals(unknownRates.body.error, 'invalid usage at index 0: rates has unknown dimensions: ouput');
});

test('import rejects invalid records before clearing existing data', async () => {
  const { app, repo } = setup();
  await repo.apiKeys.save(KEY_A);
  await repo.upstreams.save(CUSTOM_UPSTREAM);
  await repo.searchUsage.set(SEARCH_USAGE_1);

  const badApiKeys = await doImport(app, 'replace', {
    users: [SEED_ADMIN],
    apiKeys: [{ ...KEY_B, key: '' }],
    upstreams: [],
    usage: [],
    searchUsage: [],
    performanceIncluded: false,
    searchConfig: DEFAULT_SEARCH_CONFIG,
  });
  const badUsage = await doImport(app, 'replace', {
    users: [SEED_ADMIN],
    apiKeys: [],
    upstreams: [],
    usage: [{ ...USAGE_2, requests: -1 }],
    searchUsage: [],
    performanceIncluded: false,
    searchConfig: DEFAULT_SEARCH_CONFIG,
  });
  const badUpstream = await doImport(app, 'replace', {
    users: [SEED_ADMIN],
    apiKeys: [],
    upstreams: [{ ...upstreamRecordToFullJson(CUSTOM_UPSTREAM), config: { baseUrl: 'https://custom.example.com', authStyle: 'bearer', apiKey: 'sk', endpoints: { bogus: {} } } }],
    usage: [],
    searchUsage: [],
    performanceIncluded: false,
    searchConfig: DEFAULT_SEARCH_CONFIG,
  });
  const badFixes = await doImport(app, 'replace', {
    users: [SEED_ADMIN],
    apiKeys: [],
    upstreams: [{ ...upstreamRecordToFullJson(CUSTOM_UPSTREAM), flag_overrides: { 'made-up-fix': true } }],
    usage: [],
    searchUsage: [],
    performanceIncluded: false,
    searchConfig: DEFAULT_SEARCH_CONFIG,
  });
  const badSearchUsage = await doImport(app, 'replace', {
    users: [SEED_ADMIN],
    apiKeys: [],
    upstreams: [],
    usage: [],
    searchUsage: [{ provider: 'not-real', keyId: 'key-a', hour: '2026-01-01T10', requests: 1 }],
    performanceIncluded: false,
    searchConfig: DEFAULT_SEARCH_CONFIG,
  });

  assertEquals(badApiKeys.status, 400);
  assertEquals(badApiKeys.body.error, 'invalid apiKeys at index 0: key must be a non-empty string');
  assertEquals(badUsage.status, 400);
  assertEquals(badUsage.body.error, 'invalid usage at index 0: record has invalid usage fields');
  assertEquals(badUpstream.status, 400);
  assertEquals(String(badUpstream.body.error).includes('invalid upstreams at index 0'), true);
  assertEquals(badFixes.status, 400);
  assertEquals(badFixes.body.error, 'invalid upstreams at index 0: Unknown flag_overrides ids: made-up-fix');
  assertEquals(badSearchUsage.status, 400);
  assertEquals(badSearchUsage.body.error, 'invalid searchUsage at index 0: invalid provider');
  assertEquals(await repo.apiKeys.list(), [KEY_A]);
  assertEquals(await repo.upstreams.list(), [CUSTOM_UPSTREAM]);
  assertEquals(await repo.searchUsage.listAll(), [SEARCH_USAGE_1]);
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
  const restored = await repo.apiKeys.getById(KEY_A.id);
  assertEquals(restored?.dumpRetentionSeconds, 3600);
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

test('import rejects missing latest-v11 arrays before clearing existing data', async () => {
  const { app, repo } = setup();
  await repo.apiKeys.save(KEY_A);
  await repo.upstreams.save(CUSTOM_UPSTREAM);
  await repo.usage.set(USAGE_1);
  await repo.searchUsage.set(SEARCH_USAGE_1);

  const missingApiKeys = await doImport(app, 'replace', latestImportData({ apiKeys: undefined }));
  const missingUsage = await doImport(app, 'replace', latestImportData({ usage: undefined }));
  const missingSearchUsage = await doImport(app, 'replace', latestImportData({ searchUsage: undefined }));

  assertEquals(missingApiKeys.status, 400);
  assertEquals(missingApiKeys.body.error, 'invalid apiKeys: apiKeys must be an array');
  assertEquals(missingUsage.status, 400);
  assertEquals(missingUsage.body.error, 'invalid usage: usage must be an array');
  assertEquals(missingSearchUsage.status, 400);
  assertEquals(missingSearchUsage.body.error, 'invalid searchUsage: searchUsage must be an array');
  assertEquals(await repo.apiKeys.list(), [KEY_A]);
  assertEquals(await repo.upstreams.list(), [CUSTOM_UPSTREAM]);
  assertEquals(await repo.usage.listAll(), [USAGE_1]);
  assertEquals(await repo.searchUsage.listAll(), [SEARCH_USAGE_1]);
});

test('import validates mode and data before mutating', async () => {
  const { app } = setup();

  const invalidMode = await doImport(app, 'invalid', {}, 11);
  const missingData = await app.request('/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'replace', version: 11 }),
  });
  const missingUpstreams = await doImport(app, 'merge', {}, 11);
  const emptyMerge = await doImport(app, 'merge', latestImportData(), 11);

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

test('v11 export/import round-trips users and per-key user_id', async () => {
  const { app, repo } = setup();
  await repo.users.save(SEED_ADMIN);
  await repo.users.save(USER_BOB);
  await repo.apiKeys.save(KEY_A);
  await repo.apiKeys.save({ ...KEY_B, userId: USER_BOB.id });

  const exportResult = await doExport(app);
  assertEquals(exportResult.version, 11);
  assertEquals(exportResult.data.users.map((u: any) => u.id).sort(), [SEED_ADMIN.id, USER_BOB.id]);

  const result = await doImport(app, 'replace', exportResult.data, 11);
  assertEquals(result.status, 200);
  assertEquals(result.body.imported.users, 2);
  assertEquals(result.body.imported.apiKeys, 2);

  const restoredUsers = await repo.users.listIncludingDeleted();
  assertEquals(restoredUsers.find(u => u.id === USER_BOB.id)?.passwordHash, USER_BOB.passwordHash);
  const restoredKey = await repo.apiKeys.getById(KEY_B.id);
  assertEquals(restoredKey?.userId, USER_BOB.id);
});

test('v11 import rejects api_keys whose user_id does not appear in the payload', async () => {
  const { app, repo } = setup();
  await repo.users.save(SEED_ADMIN);

  const result = await doImport(app, 'replace', {
    users: [SEED_ADMIN],
    apiKeys: [{ ...KEY_A, userId: 99 }],
    upstreams: [],
    usage: [],
    searchUsage: [],
    performanceIncluded: false,
    searchConfig: DEFAULT_SEARCH_CONFIG,
  }, 11);

  assertEquals(result.status, 400);
  assertEquals(result.body.error, 'invalid apiKeys at index 0: user_id 99 does not match any user in the payload');
});

test('v11 import rejects malformed users (bad username, bad password_hash)', async () => {
  const { app } = setup();

  const badUsername = await doImport(app, 'replace', {
    users: [{ ...USER_BOB, username: 'has space' }],
    apiKeys: [],
    upstreams: [],
    usage: [],
    searchUsage: [],
    performanceIncluded: false,
    searchConfig: DEFAULT_SEARCH_CONFIG,
  }, 11);
  assertEquals(badUsername.status, 400);
  assertEquals(String(badUsername.body.error).startsWith('invalid users at index 0:'), true);

  const badHash = await doImport(app, 'replace', {
    users: [{ ...USER_BOB, passwordHash: 'argon2$10000$$' }],
    apiKeys: [],
    upstreams: [],
    usage: [],
    searchUsage: [],
    performanceIncluded: false,
    searchConfig: DEFAULT_SEARCH_CONFIG,
  }, 11);
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
    searchConfig: DEFAULT_SEARCH_CONFIG,
  }, 3);

  assertEquals(result.status, 400);
  assertEquals(String(result.body.error).includes('version must be 11'), true);
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
    searchConfig: DEFAULT_SEARCH_CONFIG,
  }, 11);

  assertEquals(result.status, 200);
  // No public listAll on sessions; create a fresh session and check the
  // deletion happened by directly calling deleteByUserId — both should report 0.
  assertEquals(await repo.sessions.deleteByUserId(SEED_ADMIN.id), 0);
  assertEquals(await repo.sessions.deleteByUserId(USER_BOB.id), 0);
});

test('v11 import rejects users[i].upstreamIds === undefined', async () => {
  const { app } = setup();
  const result = await doImport(app, 'replace', {
    users: [SEED_ADMIN, { ...USER_BOB, upstreamIds: undefined }],
    apiKeys: [],
    upstreams: [],
    usage: [],
    searchUsage: [],
    performanceIncluded: false,
    searchConfig: DEFAULT_SEARCH_CONFIG,
  }, 11);
  assertEquals(result.status, 400);
  expect(result.body.error).toMatch(/upstreamIds/);
});

test('v11 import rejects users[i].deletedAt of non-string non-null type', async () => {
  const { app } = setup();
  const result = await doImport(app, 'replace', {
    users: [SEED_ADMIN, { ...USER_BOB, deletedAt: 42 }],
    apiKeys: [],
    upstreams: [],
    usage: [],
    searchUsage: [],
    performanceIncluded: false,
    searchConfig: DEFAULT_SEARCH_CONFIG,
  }, 11);
  assertEquals(result.status, 400);
  expect(result.body.error).toMatch(/deletedAt/);
});

test('v11 replace import refuses payload missing user 1', async () => {
  const { app } = setup();
  const result = await doImport(app, 'replace', {
    users: [USER_BOB],
    apiKeys: [],
    upstreams: [],
    usage: [],
    searchUsage: [],
    performanceIncluded: false,
    searchConfig: DEFAULT_SEARCH_CONFIG,
  }, 11);
  assertEquals(result.status, 400);
  expect(result.body.error).toMatch(/user 1/);
});

test('a full v11 export re-imports verbatim — the export→import round trip is closed', async () => {
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
  await repo.searchUsage.set(SEARCH_USAGE_1);
  await repo.searchUsage.set(SEARCH_USAGE_2);
  await repo.performance.set(PERFORMANCE_1);
  await repo.performance.set(PERFORMANCE_2);
  const config = {
    provider: 'tavily' as const,
    tavily: { apiKey: 'tk' },
    microsoftGrounding: { apiKey: '' },
    jina: { apiKey: '' },
    passthroughOpenAiSearch: { enabled: false, upstreamId: '', model: '' },
  };
  await repo.searchConfig.save(config);

  const exported = await doExport(app, true);
  assertEquals(exported.version, 11);

  // Replace-import the export's own `data`, verbatim. If the export emits any
  // shape the import parser rejects, this 400s — the round trip is the
  // invariant, so this test fails the moment the two sides drift.
  const result = await doImport(app, 'replace', exported.data, 11);
  assertEquals(result.status, 200);
  assertEquals(result.body.imported, { users: 2, apiKeys: 2, upstreams: 4, proxies: 0, usage: 2, searchUsage: 2, performance: 2 });

  // Spot-check fidelity across collection types (order-independent).
  assertEquals((await repo.upstreams.list()).find(u => u.id === 'up_codex_a')?.state, CODEX_UPSTREAM.state);
  assertEquals((await repo.users.listIncludingDeleted()).find(u => u.id === USER_BOB.id), USER_BOB);
  assertEquals((await repo.apiKeys.getById('key-b'))?.userId, USER_BOB.id);
  assertEquals((await repo.usage.listAll()).find(u => u.keyId === 'key-a' && u.hour === USAGE_1.hour), USAGE_1);
  assertEquals((await repo.performance.listAll()).find(p => p.keyId === 'key-a' && p.hour === PERFORMANCE_1.hour), PERFORMANCE_1);
  assertEquals(await repo.searchConfig.get(), config);
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
    searchConfig: DEFAULT_SEARCH_CONFIG,
  };

  for (const version of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
    const result = await doImport(app, 'replace', wellFormed, version);
    assertEquals(result.status, 400);
    assertEquals(String(result.body.error).includes('version must be 11'), true);
  }

  // Nothing was touched — the version gate runs before any delete or write.
  assertEquals(await repo.apiKeys.list(), [KEY_A]);
  assertEquals((await repo.upstreams.list()).map(u => u.id), ['up_custom_a']);
});

test('replace-mode import purges every pre-existing key dump and cuts SSE subscribers', async () => {
  const { app, repo } = setup();
  await repo.apiKeys.save({ ...KEY_A, dumpRetentionSeconds: 3600 });
  await repo.apiKeys.save({ ...KEY_B, dumpRetentionSeconds: 1800 });
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);

  const result = await doImport(app, 'replace', latestImportData({
    apiKeys: [{ ...KEY_A, dumpRetentionSeconds: 3600 }],
  }));
  assertEquals(result.status, 200);
  assertEquals(stubs.purgedAll.includes(KEY_A.id), true);
  assertEquals(stubs.purgedAll.includes(KEY_B.id), true);
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
  assertEquals(stubs.purgedAll.includes(KEY_A.id), true);
});

test('merge-mode import flipping retention to null purges + closes the channel', async () => {
  const { app, repo } = setup();
  await repo.apiKeys.save({ ...KEY_A, dumpRetentionSeconds: 3600 });
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);

  const result = await doImport(app, 'merge', latestImportData({
    apiKeys: [{ ...KEY_A, dumpRetentionSeconds: null }],
  }));
  assertEquals(result.status, 200);
  assertEquals(stubs.purgedAll.includes(KEY_A.id), true);
  assertEquals(stubs.closedChannels.some(c => c.keyId === KEY_A.id), true);
});

test('merge-mode import shrinking retention purges expired with the new window', async () => {
  const { app, repo } = setup();
  await repo.apiKeys.save({ ...KEY_A, dumpRetentionSeconds: 7200 });
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);

  const result = await doImport(app, 'merge', latestImportData({
    apiKeys: [{ ...KEY_A, dumpRetentionSeconds: 1800 }],
  }));
  assertEquals(result.status, 200);
  const call = stubs.purgedExpired.find(c => c.keyId === KEY_A.id);
  expect(call).toBeDefined();
  assertEquals(call!.retentionSeconds, 1800);
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
  assertEquals(stubs.purgedAll.includes(KEY_A.id), true);
});

test('replace-mode import surfaces a purgeAll failure', async () => {
  // Replace mode promises data isolation: a reused key id in the imported
  // payload cannot inherit the previous owner's captures. A swallowed
  // purgeAll failure would defeat that — let the throw propagate so the
  // operator sees a 500 instead of silently importing on top of stale dumps.
  const { app, repo } = setup();
  await repo.apiKeys.save({ ...KEY_A, dumpRetentionSeconds: 3600 });
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);
  stubs.failOn('purgeAll', new Error('store down'));

  const resp = await app.request('/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mode: 'replace', version: 11, data: latestImportData({
        apiKeys: [{ ...KEY_A, dumpRetentionSeconds: 3600 }],
      }),
    }),
  });
  assertEquals(resp.status, 500);
});

test('merge-mode retention transition surfaces a purgeAll failure', async () => {
  const { app, repo } = setup();
  await repo.apiKeys.save({ ...KEY_A, dumpRetentionSeconds: 3600 });
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);
  stubs.failOn('purgeAll', new Error('store down'));

  const resp = await app.request('/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mode: 'merge', version: 11, data: latestImportData({
        apiKeys: [{ ...KEY_A, dumpRetentionSeconds: null }],
      }),
    }),
  });
  assertEquals(resp.status, 500);
});
