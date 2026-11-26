import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';

import { exportData, importData } from '../../../src/control-plane/data-transfer/routes.ts';
import { exportQuery, importBody } from '../../../src/control-plane/schemas.ts';
import { upstreamRecordToFullJson } from '../../../src/control-plane/upstreams/serialize.ts';
import { DEFAULT_WEB_SEARCH_CONFIG } from '../../../src/data-plane/tools/web-search/config.ts';
import { initDumpBroker, initDumpStore } from '../../../src/dump/registry.ts';
import { zValidator } from '../../../src/middleware/zod-validator.ts';
import { initRepo } from '../../../src/repo/index.ts';
import { SqlRepo } from '../../../src/repo/sql.ts';
import type { ApiKey, GroupWithMembers, Repo, PerformanceTelemetryRecord, WebSearchUsageRecord, StoredOpenAIResponsesItem, StoredUpstreamRecord, UsageRecord, User } from '../../../src/repo/types.ts';
import { tokenUsageMetrics } from '../../../src/repo/usage-metrics.ts';
import { installDumpStubs } from '../../dump/test-fixtures.ts';
import { InMemoryRepo } from '../../repo/memory.ts';
import { createSqliteTestDb } from '../../repo/test-sqlite.ts';
import { saveUpstreamForTest } from '../../repo/upstreams.ts';
import { assertEquals } from '@floway-dev/test-utils';

const KEY_A: ApiKey = {
  id: 'key-a',
  userId: 1,
  name: 'Alice',
  key: 'raw-a',
  serverSecret: '11'.repeat(32),
  createdAt: '2026-01-01T00:00:00.000Z',
  lastUsedAt: '2026-01-02T00:00:00.000Z',
  upstreamIds: null,
  randomizeUpstreams: false,
  deletedAt: null,
  dumpRetentionSeconds: null,
  openaiResponsesRetentionSeconds: 0,
};

const KEY_B: ApiKey = {
  id: 'key-b',
  userId: 1,
  name: 'Bob',
  key: 'raw-b',
  serverSecret: '22'.repeat(32),
  createdAt: '2026-02-01T00:00:00.000Z',
  upstreamIds: null,
  randomizeUpstreams: false,
  deletedAt: null,
  dumpRetentionSeconds: null,
  openaiResponsesRetentionSeconds: 0,
};

const SEED_ADMIN: User = {
  id: 1,
  username: 'admin',
  passwordHash: null,
  isAdmin: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  deletedAt: null,
};

const USER_BOB: User = {
  id: 2,
  username: 'bob',
  passwordHash: 'pbkdf2-sha256$600000$c2FsdA==$aGFzaA==',
  isAdmin: false,
  createdAt: '2026-02-01T00:00:00.000Z',
  deletedAt: null,
};

const EMPTY_MODELS_CACHE = { revision: null, fetchedAt: null, lastError: null };

const CUSTOM_UPSTREAM: StoredUpstreamRecord = {
  id: 'up_custom_a',
  kind: 'custom',
  name: 'Custom A',
  enabled: true,
  usageRefreshIntervalMinutes: 0,
  sortOrder: 10,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  flagOverrides: { 'anthropic-messages-web-search-shim': true },
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  version: 1,
  modelsCache: EMPTY_MODELS_CACHE,
  hue: 210,
  config: {
    baseUrl: 'https://custom.example.com',
    ingressHeadersRules: [
      { key: 'x-request-id', value: null },
      { key: 'x-route', value: 'backup' },
    ],
    apiKey: 'sk-custom',
    endpoints: { openaiChatCompletions: {}, openaiResponses: {} },
    modelsFetch: { enabled: true, authStyle: 'bearer', endpoint: '/models' },
  },
  state: null,
};

const COPILOT_UPSTREAM: StoredUpstreamRecord = {
  id: 'up_copilot_a',
  kind: 'copilot',
  name: 'GitHub Copilot (alice)',
  enabled: true,
  usageRefreshIntervalMinutes: 0,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  version: 1,
  modelsCache: EMPTY_MODELS_CACHE,
  hue: 210,
  config: {
    githubHost: 'github.com',
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

const AZURE_MANUAL_MODELS = [
  {
    upstreamModelId: 'gpt-prod',
    publicModelId: 'gpt-public',
    kind: 'chat' as const,
    endpoints: { openaiChatCompletions: {}, openaiResponses: {}, openaiEmbeddings: {} },
  },
  {
    upstreamModelId: 'deepseek-prod',
    kind: 'chat' as const,
    endpoints: { openaiChatCompletions: {} },
  },
];

const AZURE_UPSTREAM: StoredUpstreamRecord = {
  id: 'up_azure_a',
  kind: 'azure',
  name: 'Azure A',
  enabled: true,
  usageRefreshIntervalMinutes: 0,
  sortOrder: 20,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  flagOverrides: {},
  disabledPublicModelIds: ['gpt-public'],
  proxyFallbackList: [],
  modelPrefix: null,
  version: 1,
  modelsCache: EMPTY_MODELS_CACHE,
  hue: 210,
  config: {
    endpoint: 'https://example.openai.azure.com',
    apiKey: 'az-key',
  },
  state: null,
};

const CHATGPT_UPSTREAM: StoredUpstreamRecord = {
  id: 'up_chatgpt_a',
  kind: 'chatgpt',
  name: 'ChatGPT (alice)',
  enabled: true,
  usageRefreshIntervalMinutes: 0,
  sortOrder: 30,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  version: 1,
  modelsCache: EMPTY_MODELS_CACHE,
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

const STORED_OPENAI_RESPONSES_ITEM: StoredOpenAIResponsesItem = {
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

const setup = (repo: Repo = new InMemoryRepo()) => {
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

const doImport = async (app: Hono, mode: string, data: unknown, version: unknown = 26) => {
  const resp = await app.request('/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode, version, data }),
  });
  return { status: resp.status, body: (await resp.json()) as Record<string, any> };
};

const latestImportData = (overrides: Record<string, unknown> = {}) => ({
  users: [SEED_ADMIN],
  userPreferences: [],
  groups: [],
  accessRecords: [],
  apiKeys: [],
  upstreams: [],
  usage: [],
  searchUsage: [],
  upstreamMetrics: [],
  performanceIncluded: false,
  searchConfig: DEFAULT_WEB_SEARCH_CONFIG,
  siteSettings: { siteName: null },
  ...overrides,
});

const transferGroup = (id: number, name: string, deletedAt: string | null = null): GroupWithMembers => ({
  id, name, hue: 120, createdAt: '2026-10-16T00:00:00Z', deletedAt, memberIds: [1],
});

describe.each([
  ['memory', () => Promise.resolve(new InMemoryRepo())],
  ['sql', async () => new SqlRepo(await createSqliteTestDb())],
] as const)('group imports (%s)', (_label, makeRepo) => {
  test.each(['replace', 'merge'])('rejects duplicate active group names before any %s writes', async mode => {
    const { app, repo } = setup(await makeRepo());
    await repo.apiKeys.save(KEY_A);
    await repo.groups.restore([transferGroup(1, 'Original')]);
    const before = (await doExport(app)).data;
    const result = await doImport(app, mode, latestImportData({ groups: [transferGroup(2, 'Ops'), transferGroup(3, 'ops')] }));
    expect(result.status).toBe(400);
    expect(result.body.error).toContain('group names');
    expect((await doExport(app)).data).toEqual(before);
  });

  test('rejects a merge conflict with a retained group before changing users or keys', async () => {
    const { app, repo } = setup(await makeRepo());
    await repo.apiKeys.save(KEY_A);
    await repo.groups.restore([transferGroup(1, 'Ops')]);
    const before = (await doExport(app)).data;
    const result = await doImport(app, 'merge', latestImportData({ groups: [transferGroup(2, 'ops')] }));
    expect(result.status).toBe(400);
    expect((await doExport(app)).data).toEqual(before);
  });

});

const EMPTY_ACCESS_TRANSFER = { groups: [], accessRecords: [] } as const;

test('import rejects any version other than the current one before deleting data', async () => {
  const { app, repo } = setup();
  await repo.apiKeys.save(KEY_A);
  await saveUpstreamForTest(repo.upstreams, CUSTOM_UPSTREAM);

  const VERSION_ERROR = 'version must be 26 — older export formats are not supported; re-export from the current deployment';
  const previousV25 = await doImport(app, 'replace', latestImportData(), 25);
  const previousV11 = await doImport(app, 'replace', latestImportData(), 11);
  const ancientVersion = await doImport(app, 'replace', { apiKeys: [] }, 1);
  const missingVersionResponse = await app.request('/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'replace', data: { apiKeys: [] } }),
  });
  const missingVersion = { status: missingVersionResponse.status, body: (await missingVersionResponse.json()) as Record<string, any> };

  assertEquals(previousV25.status, 400);
  assertEquals(previousV25.body.error, VERSION_ERROR);
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
  await repo.apiKeys.save({ ...KEY_A, openaiResponsesRetentionSeconds: 24 * 60 * 60 });
  await saveUpstreamForTest(repo.upstreams, CUSTOM_UPSTREAM);
  await repo.usage.set(USAGE_1);
  await repo.webSearchUsage.set(WEB_SEARCH_USAGE_1);
  await repo.openaiResponsesItems.insertMany([STORED_OPENAI_RESPONSES_ITEM], 0);
  await repo.webSearchConfig.save({
    provider: 'tavily',
    tavily: { apiKey: 'old' },
    microsoftWebIq: { apiKey: '' },
    jina: { apiKey: '' },
    passthroughOpenAiSearch: { enabled: false, upstreamId: '', model: '' },
  });

  const result = await doImport(app, 'replace', {
    ...EMPTY_ACCESS_TRANSFER,
    users: [SEED_ADMIN],
    apiKeys: [KEY_B],
    upstreams: [upstreamRecordToFullJson(AZURE_UPSTREAM, AZURE_MANUAL_MODELS)],
    usage: [USAGE_2],
    searchUsage: [WEB_SEARCH_USAGE_2],
    upstreamMetrics: [],
    performanceIncluded: false,
    searchConfig: {
      provider: 'microsoft-web-iq',
      tavily: { apiKey: '' },
      microsoftWebIq: { apiKey: 'ms-new' },
      jina: { apiKey: '' },
      passthroughOpenAiSearch: { enabled: false, upstreamId: '', model: '' },
    },
    siteSettings: { siteName: null },
  });

  assertEquals(result.status, 200);
  assertEquals(result.body.imported, { users: 1, userPreferences: 0, groups: 0, accessRecords: 0, apiKeys: 1, upstreams: 1, proxies: 0, usage: 1, searchUsage: 1, upstreamMetrics: 0, performance: 0 });
  const restoredKey = await repo.apiKeys.findByRawKey(KEY_B.key);
  if (restoredKey === null) throw new Error('restored key missing');
  assertEquals(restoredKey, KEY_B);
  const restoredUpstreams = await repo.upstreams.list();
  assertEquals(restoredUpstreams.map(({ modelsCache: _modelsCache, ...rest }) => rest), [
    (({ modelsCache: _modelsCache, ...rest }) => ({ ...rest, sortOrder: 0 }))(AZURE_UPSTREAM),
  ]);
  assertEquals(typeof restoredUpstreams[0]?.modelsCache.fetchedAt, 'number');
  assertEquals(await repo.upstreamModels.listManualModels(AZURE_UPSTREAM.id), AZURE_MANUAL_MODELS);
  assertEquals(await repo.usage.listAll(), [USAGE_2]);
  assertEquals(await repo.webSearchUsage.listAll(), [WEB_SEARCH_USAGE_2]);
  assertEquals(await repo.openaiResponsesItems.lookupMany('key-a', [STORED_OPENAI_RESPONSES_ITEM.id], 0), []);
  assertEquals(await repo.webSearchConfig.get(), {
    provider: 'microsoft-web-iq',
    tavily: { apiKey: '' },
    microsoftWebIq: { apiKey: 'ms-new' },
    jina: { apiKey: '' },
    passthroughOpenAiSearch: { enabled: false, upstreamId: '', model: '' },
  });
});

test('import merge upserts by repository key without clearing unrelated rows', async () => {
  const { app, repo } = setup();
  await repo.apiKeys.save(KEY_A);
  await saveUpstreamForTest(repo.upstreams, CUSTOM_UPSTREAM);
  await saveUpstreamForTest(repo.upstreams, AZURE_UPSTREAM, { manualModels: AZURE_MANUAL_MODELS });
  await repo.usage.set({ ...USAGE_1, requests: 10 });
  await repo.webSearchUsage.set({ ...WEB_SEARCH_USAGE_1, requests: 10 });

  const updatedCustom = { ...CUSTOM_UPSTREAM, name: 'Custom Updated', updatedAt: '2026-03-01T00:00:00.000Z' } satisfies StoredUpstreamRecord;
  const result = await doImport(app, 'merge', latestImportData({
    apiKeys: [{ ...KEY_A, name: 'Alice Updated' }, KEY_B],
    upstreams: [upstreamRecordToFullJson(updatedCustom), upstreamRecordToFullJson(COPILOT_UPSTREAM)],
    usage: [USAGE_1],
    searchUsage: [WEB_SEARCH_USAGE_1],
  }));

  assertEquals(result.status, 200);
  assertEquals((await repo.apiKeys.list()).map(key => key.name), ['Alice Updated', 'Bob']);
  assertEquals((await repo.upstreams.list()).map(upstream => [upstream.id, upstream.name, upstream.sortOrder]), [
    ['up_copilot_a', 'GitHub Copilot (alice)', 0],
    ['up_custom_a', 'Custom Updated', 1],
    ['up_azure_a', 'Azure A', 2],
  ]);
  assertEquals(await repo.usage.listAll(), [USAGE_1]);
  assertEquals(await repo.webSearchUsage.listAll(), [WEB_SEARCH_USAGE_1]);
});

test('import rejects performance records that break the recorder invariants', async () => {
  const { app } = setup();

  const withPerf = (record: PerformanceTelemetryRecord) => latestImportData({
    upstreamMetrics: [],
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
  expect(partitionMismatch.body.error).toContain('must equal requests');

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
  expect(tpotBeyondTtft.body.error).toContain('tpotSamples must not exceed');

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
  expect(ttftBucketMismatch.body.error).toContain('ttft_ms bucket sum');

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
  expect(tpotBucketMismatch.body.error).toContain('tpot_us bucket sum');

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
  expect(duplicateBucket.body.error).toContain('duplicate bucket');
});

test('import rejects invalid records before clearing existing data', async () => {
  const { app, repo } = setup();
  await repo.apiKeys.save(KEY_A);
  await saveUpstreamForTest(repo.upstreams, CUSTOM_UPSTREAM);
  await repo.webSearchUsage.set(WEB_SEARCH_USAGE_1);

  const badApiKeys = await doImport(app, 'replace', {
    ...EMPTY_ACCESS_TRANSFER,
    users: [SEED_ADMIN],
    apiKeys: [{ ...KEY_B, key: '' }],
    upstreams: [],
    usage: [],
    searchUsage: [],
    upstreamMetrics: [],
    performanceIncluded: false,
    searchConfig: DEFAULT_WEB_SEARCH_CONFIG,
    siteSettings: { siteName: null },
  });
  const badUsage = await doImport(app, 'replace', {
    ...EMPTY_ACCESS_TRANSFER,
    users: [SEED_ADMIN],
    apiKeys: [],
    upstreams: [],
    usage: [{ ...USAGE_2, requests: -1 }],
    searchUsage: [],
    upstreamMetrics: [],
    performanceIncluded: false,
    searchConfig: DEFAULT_WEB_SEARCH_CONFIG,
    siteSettings: { siteName: null },
  });
  const badUpstream = await doImport(app, 'replace', {
    ...EMPTY_ACCESS_TRANSFER,
    users: [SEED_ADMIN],
    apiKeys: [],
    upstreams: [{ ...upstreamRecordToFullJson(CUSTOM_UPSTREAM), config: { baseUrl: 'https://custom.example.com', apiKey: 'sk', endpoints: { bogus: {} } } }],
    usage: [],
    searchUsage: [],
    upstreamMetrics: [],
    performanceIncluded: false,
    searchConfig: DEFAULT_WEB_SEARCH_CONFIG,
    siteSettings: { siteName: null },
  });
  const badFixes = await doImport(app, 'replace', {
    ...EMPTY_ACCESS_TRANSFER,
    users: [SEED_ADMIN],
    apiKeys: [],
    upstreams: [{ ...upstreamRecordToFullJson(CUSTOM_UPSTREAM), flag_overrides: { 'made-up-fix': true } }],
    usage: [],
    searchUsage: [],
    upstreamMetrics: [],
    performanceIncluded: false,
    searchConfig: DEFAULT_WEB_SEARCH_CONFIG,
    siteSettings: { siteName: null },
  });
  const badWebSearchUsage = await doImport(app, 'replace', {
    ...EMPTY_ACCESS_TRANSFER,
    users: [SEED_ADMIN],
    apiKeys: [],
    upstreams: [],
    usage: [],
    searchUsage: [{ provider: 'not-real', keyId: 'key-a', hour: '2026-01-01T10', requests: 1 }],
    upstreamMetrics: [],
    performanceIncluded: false,
    searchConfig: DEFAULT_WEB_SEARCH_CONFIG,
    siteSettings: { siteName: null },
  });

  assertEquals(badApiKeys.status, 400);
  expect(badApiKeys.body.error).toContain('apiKeys');
  assertEquals(badUsage.status, 400);
  expect(badUsage.body.error).toContain('usage');
  assertEquals(badUpstream.status, 400);
  expect(badUpstream.body.error).toContain('upstreams');
  assertEquals(badFixes.status, 400);
  expect(badFixes.body.error).toContain('flag_overrides');
  assertEquals(badWebSearchUsage.status, 400);
  expect(badWebSearchUsage.body.error).toContain('searchUsage');
  assertEquals(await repo.apiKeys.list(), [KEY_A]);
  assertEquals(await repo.upstreams.list(), [CUSTOM_UPSTREAM]);
  assertEquals(await repo.webSearchUsage.listAll(), [WEB_SEARCH_USAGE_1]);
});

test('import strips unknown fields at transferable record boundaries', async () => {
  const { app, repo } = setup();
  const result = await doImport(app, 'replace', latestImportData({
    ...EMPTY_ACCESS_TRANSFER,
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
    upstreamMetrics: [],
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

test('import rejects api key unique identity conflicts before mutating', async () => {
  const { app, repo } = setup();
  await repo.apiKeys.save(KEY_A);
  await saveUpstreamForTest(repo.upstreams, CUSTOM_UPSTREAM);

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
  expect(duplicateRawKey.body.error).toContain('raw key');
  assertEquals(duplicateId.status, 400);
  expect(duplicateId.body.error).toContain('id key-b');
  assertEquals(duplicateServerSecret.status, 400);
  expect(duplicateServerSecret.body.error).toContain('server secret');
  assertEquals(mergeExistingRawKeyConflict.status, 400);
  expect(mergeExistingRawKeyConflict.body.error).toContain('raw key');
  assertEquals(mergeExistingServerSecretConflict.status, 400);
  expect(mergeExistingServerSecretConflict.body.error).toContain('server secret');
  assertEquals(await repo.apiKeys.list(), [KEY_A]);
  assertEquals(await repo.upstreams.list(), [CUSTOM_UPSTREAM]);
});

const HTTP_PROXY_URL = 'http://198.51.100.20:3128';
const SOCKS_PROXY_URL = 'socks5://user:pass@198.51.100.10:1080';

test('import in replace mode rejects an upstream fallback reference that does not resolve to an imported proxy', async () => {
  const { app, repo } = setup();
  await saveUpstreamForTest(repo.upstreams, CUSTOM_UPSTREAM);

  const result = await doImport(app, 'replace', latestImportData({
    upstreams: [{ ...upstreamRecordToFullJson(CUSTOM_UPSTREAM), proxy_fallback_list: [{ id: 'p_missing' }, { id: 'direct_fetch' }] }],
    proxies: [],
  }));

  assertEquals(result.status, 400);
  expect(result.body.error).toContain('p_missing');
  assertEquals(await repo.upstreams.list(), [CUSTOM_UPSTREAM]);
});

test('import replace wipes proxy_upstream_backoffs alongside the proxies it cools down', async () => {
  // Backoff rows survive only as long as the proxy_id they reference is real;
  // a replace import that brings in a fresh proxy with the same id as a wiped
  // one would otherwise have its first dials short-circuited by a stale
  // cool-down row from the prior catalog.
  const { app, repo } = setup();
  await repo.proxies.save({ id: 'p_old', name: 'Old', url: HTTP_PROXY_URL, dialTimeoutSeconds: null });
  await saveUpstreamForTest(repo.upstreams, CUSTOM_UPSTREAM);
  await repo.proxyBackoffs.recordDialFailure('p_old', CUSTOM_UPSTREAM.id, 'transport reset');
  assertEquals((await repo.proxyBackoffs.listAll()).length, 1);

  const result = await doImport(app, 'replace', latestImportData({
    proxies: [{ id: 'p_old', name: 'New', url: SOCKS_PROXY_URL, dial_timeout_seconds: null }],
    upstreams: [upstreamRecordToFullJson(CUSTOM_UPSTREAM)],
  }));

  assertEquals(result.status, 200);
  assertEquals(await repo.proxyBackoffs.listAll(), []);
});

test('replace-mode import clears sessions before writing users', async () => {
  const { app, repo } = setup();
  await repo.users.save(SEED_ADMIN);
  await repo.users.save(USER_BOB);
  await repo.sessions.create(SEED_ADMIN.id);
  await repo.sessions.create(USER_BOB.id);

  const result = await doImport(app, 'replace', {
    ...EMPTY_ACCESS_TRANSFER,
    users: [SEED_ADMIN, USER_BOB],
    apiKeys: [],
    upstreams: [],
    usage: [],
    searchUsage: [],
    upstreamMetrics: [],
    performanceIncluded: false,
    searchConfig: DEFAULT_WEB_SEARCH_CONFIG,
    siteSettings: { siteName: null },
  }, 26);

  assertEquals(result.status, 200);
  // No public listAll on sessions; create a fresh session and check the
  // deletion happened by directly calling deleteByUserId — both should report 0.
  assertEquals(await repo.sessions.deleteByUserId(SEED_ADMIN.id), 0);
  assertEquals(await repo.sessions.deleteByUserId(USER_BOB.id), 0);
});

test('v26 replace import refuses payload missing user 1', async () => {
  const { app } = setup();
  const result = await doImport(app, 'replace', {
    ...EMPTY_ACCESS_TRANSFER,
    users: [USER_BOB],
    apiKeys: [],
    upstreams: [],
    usage: [],
    searchUsage: [],
    upstreamMetrics: [],
    performanceIncluded: false,
    searchConfig: DEFAULT_WEB_SEARCH_CONFIG,
    siteSettings: { siteName: null },
  }, 26);
  assertEquals(result.status, 400);
  expect(result.body.error).toContain('user 1');
});

test('a full v26 export re-imports verbatim — the export→import round trip is closed', async () => {
  const { app, repo } = setup();
  await repo.users.save(SEED_ADMIN);
  await repo.users.save(USER_BOB);
  await repo.apiKeys.save(KEY_A);
  await repo.apiKeys.save({ ...KEY_B, userId: USER_BOB.id });
  await saveUpstreamForTest(repo.upstreams, COPILOT_UPSTREAM);
  await saveUpstreamForTest(repo.upstreams, CUSTOM_UPSTREAM);
  await saveUpstreamForTest(repo.upstreams, AZURE_UPSTREAM, { manualModels: AZURE_MANUAL_MODELS });
  await saveUpstreamForTest(repo.upstreams, CHATGPT_UPSTREAM);
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
  assertEquals(exported.version, 26);

  // Replace-import the export's own `data`, verbatim. If the export emits any
  // shape the import parser rejects, this 400s — the round trip is the
  // invariant, so this test fails the moment the two sides drift.
  const result = await doImport(app, 'replace', exported.data, 26);
  assertEquals(result.status, 200);
  assertEquals(result.body.imported, { users: 2, userPreferences: 0, groups: 0, accessRecords: 0, apiKeys: 2, upstreams: 4, proxies: 0, usage: 2, searchUsage: 2, upstreamMetrics: 0, performance: 2 });

  // Spot-check fidelity across collection types (order-independent).
  assertEquals((await repo.upstreams.list()).find(u => u.id === 'up_chatgpt_a')?.state, CHATGPT_UPSTREAM.state);
  assertEquals((await repo.users.listIncludingDeleted()).find(u => u.id === USER_BOB.id), USER_BOB);
  assertEquals((await repo.apiKeys.findByRawKey(KEY_B.key))?.userId, USER_BOB.id);
  const restoredKeyA = await repo.apiKeys.findByRawKey(KEY_A.key);
  if (restoredKeyA === null) throw new Error('restored key A missing');
  assertEquals((await repo.usage.listAll()).find(u => u.keyId === restoredKeyA.id && u.hour === USAGE_1.hour), { ...USAGE_1, keyId: restoredKeyA.id });
  assertEquals((await repo.performance.listAll()).find(p => p.keyId === restoredKeyA.id && p.hour === PERFORMANCE_1.hour), { ...PERFORMANCE_1, keyId: restoredKeyA.id });
  assertEquals(await repo.webSearchConfig.get(), config);
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

test('backup restores historical upstream gauges and replaces existing telemetry', async () => {
  const { app, repo } = setup();
  await repo.users.save(SEED_ADMIN);
  const labels = JSON.parse('{"window_seconds":18000,"__proto__":"prototype","limit":"codex"}') as Record<string, string | number>;
  const record = { upstreamId: 'deleted-seat', name: 'quota.window.used_percent', labels, timestamp: 1_000, value: 25 };
  await repo.upstreamMetrics.set(record);
  const backup = await doExport(app);
  assertEquals(Object.keys(backup.data.upstreamMetrics[0]!.labels), ['__proto__', 'limit', 'window_seconds']);
  assertEquals(Object.hasOwn(backup.data.upstreamMetrics[0]!.labels, '__proto__'), true);
  await repo.upstreamMetrics.set({ ...record, timestamp: 70_000, value: 80 });
  const restored = await doImport(app, 'replace', backup.data, backup.version);
  assertEquals(restored.status, 200);
  assertEquals(restored.body.imported.upstreamMetrics, 1);
  const [restoredRecord] = await repo.upstreamMetrics.listAll();
  assertEquals(restoredRecord, record);
  assertEquals(Object.hasOwn(restoredRecord!.labels, '__proto__'), true);
});
