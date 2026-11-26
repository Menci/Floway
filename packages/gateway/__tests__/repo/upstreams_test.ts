import { test } from 'vitest';

import { createSqliteTestDb, createSqlJsDatabase, migrationSqlByFilename, wrapSqlJsDatabase, type SqlJsDatabase } from './test-sqlite.ts';
import { saveUpstreamForTest } from './upstreams.ts';
import { SqlRepo } from '../../src/repo/sql.ts';
import type { UpstreamRepo } from '../../src/repo/types.ts';
import { divideDecimalString, priceRequest, type ModelPricing, validateModelPricing } from '@floway-dev/protocols/common';
import type { UpstreamRecord } from '@floway-dev/provider';
import { assert, assertEquals } from '@floway-dev/test-utils';

const upstream = (overrides: Partial<UpstreamRecord> & Pick<UpstreamRecord, 'id' | 'kind' | 'createdAt' | 'sortOrder'>): UpstreamRecord => ({
  name: overrides.id,
  enabled: true,
  usageRefreshIntervalMinutes: 0,
  updatedAt: overrides.createdAt,
  config: { nested: { value: overrides.id }, endpoints: { openaiChatCompletions: {} } },
  state: null,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  hue: 210,
  ...overrides,
});

const exerciseUpstreamReorder = async (repo: UpstreamRepo) => {
  for (const [id, sortOrder] of [['a', 10], ['b', 20], ['c', 40]] as const) {
    await saveUpstreamForTest(repo, upstream({ id, kind: 'custom', sortOrder, createdAt: `2026-05-21T10:00:${sortOrder}.000Z` }));
  }

  const reordered = await repo.reorder(
    ['a', 'b', 'c'],
    [{ id: 'c', sortOrder: 20 }, { id: 'b', sortOrder: 40 }],
  );
  assertEquals(reordered?.map(record => [record.id, record.sortOrder]), [['c', 20], ['b', 40]]);
  assertEquals((await repo.list()).map(record => [record.id, record.sortOrder]), [['a', 10], ['c', 20], ['b', 40]]);

  assertEquals(await repo.reorder(
    ['a', 'b', 'c'],
    [{ id: 'b', sortOrder: 20 }, { id: 'c', sortOrder: 40 }],
  ), null);
  assertEquals((await repo.list()).map(record => [record.id, record.sortOrder]), [['a', 10], ['c', 20], ['b', 40]]);
};

const exerciseAtomicAppend = async (repo: UpstreamRepo) => {
  await saveUpstreamForTest(repo, upstream({ id: 'first', kind: 'custom', sortOrder: 10, createdAt: '2026-05-21T10:00:00.000Z' }));
  const append = (id: string) => repo.insertAtEnd({ upstream: upstream({ id, kind: 'custom', sortOrder: -100, createdAt: `2026-05-21T10:00:0${id}.000Z` }) });
  const [a, b] = await Promise.all([append('1'), append('2')]);
  assert(a !== null);
  assert(b !== null);
  assertEquals(new Set([a.sortOrder, b.sortOrder]), new Set([11, 12]));
  assertEquals((await repo.list()).map(record => record.sortOrder), [10, 11, 12]);
};

test('SQL upstream repo atomically reorders a current snapshot', async () => {
  await exerciseUpstreamReorder(new SqlRepo(await createSqliteTestDb()).upstreams);
});

test('SQL upstream repo atomically assigns append ranks', async () => {
  await exerciseAtomicAppend(new SqlRepo(await createSqliteTestDb()).upstreams);
});

const exerciseSqlUpstreamRepo = async (repo: UpstreamRepo) => {
  const custom = upstream({
    id: 'up_custom_sql',
    kind: 'custom',
    name: 'Custom SQL',
    sortOrder: 2,
    createdAt: '2026-05-21T10:00:02.000Z',
    updatedAt: '2026-05-21T10:00:02.000Z',
    config: { baseUrl: 'https://custom.example/v1', apiKey: 'sk-custom', endpoints: { openaiChatCompletions: {} } },
    flagOverrides: { 'vendor-deepseek': true, 'rewrite-developer-to-system': true },
    disabledPublicModelIds: [],
  });
  const copilot = upstream({
    id: 'up_copilot_sql',
    kind: 'copilot',
    name: 'Copilot SQL',
    sortOrder: 1,
    createdAt: '2026-05-21T10:00:03.000Z',
    updatedAt: '2026-05-21T10:00:03.000Z',
    config: { githubHost: 'github.com', githubToken: 'gho_d1', user: { id: 1, login: 'copilot', name: null, avatar_url: 'https://avatars.test/1.png' } },
  });
  const azure = upstream({
    id: 'up_azure_sql',
    kind: 'azure',
    name: 'Azure SQL',
    sortOrder: 1,
    createdAt: '2026-05-21T10:00:01.000Z',
    updatedAt: '2026-05-21T10:00:01.000Z',
    config: { endpoint: 'https://azure.example', apiKey: 'azure-key', models: [] },
  });

  await saveUpstreamForTest(repo, custom);
  await saveUpstreamForTest(repo, copilot);
  await saveUpstreamForTest(repo, azure);

  assertEquals(
    (await repo.list()).map(row => row.id),
    ['up_azure_sql', 'up_copilot_sql', 'up_custom_sql'],
  );
  assertEquals((await repo.getById('up_custom_sql'))?.flagOverrides, { 'rewrite-developer-to-system': true, 'vendor-deepseek': true });
  assertEquals(await repo.getById('missing'), null);

  await saveUpstreamForTest(repo, {
    ...custom,
    name: 'Custom SQL Updated',
    enabled: false,
    usageRefreshIntervalMinutes: 0,
    sortOrder: 0,
    createdAt: '2099-01-01T00:00:00.000Z',
    updatedAt: '2026-05-21T10:00:04.000Z',
    config: { baseUrl: 'https://updated.example/v1', apiKey: 'sk-updated', endpoints: { openaiResponses: {} } },
    flagOverrides: { 'anthropic-messages-web-search-shim': true, 'rewrite-developer-to-system': true },
    disabledPublicModelIds: [],
  });
  assertEquals(
    (await repo.list()).map(row => [row.id, row.name, row.enabled]),
    [
      ['up_custom_sql', 'Custom SQL Updated', false],
      ['up_azure_sql', 'Azure SQL', true],
      ['up_copilot_sql', 'Copilot SQL', true],
    ],
  );
  assertEquals((await repo.getById('up_custom_sql'))?.createdAt, '2026-05-21T10:00:02.000Z');

  assertEquals(await repo.delete('up_azure_sql'), true);
  assertEquals(await repo.delete('up_azure_sql'), false);
  assertEquals(
    (await repo.list()).map(row => row.id),
    ['up_custom_sql', 'up_copilot_sql'],
  );

  await repo.deleteAll();
  assertEquals(await repo.list(), []);
};

test('SQL upstream repo inserts, replaces, lists, deletes, and clears rows', async () => {
  await exerciseSqlUpstreamRepo(new SqlRepo(await createSqliteTestDb()).upstreams);
});

test('migration 0072 folds every cached catalog onto its upstream row', async () => {
  const db = await createMigratedSqlJsDatabase();
  try {
    for (const filename of migrationFilenames.filter(f => f >= '0010_unified_upstreams.sql' && f < '0072_fold_models_cache.sql').toSorted()) {
      applySqlJsFile(db, filename);
    }

    db.run(`INSERT INTO upstreams (id, provider, name, enabled, sort_order, created_at, updated_at, config_json, flag_overrides, disabled_public_model_ids, proxy_fallback_list_json)
            VALUES
              ('up_clean', 'custom', 'Clean', 1, 0, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z',
                json_object('baseUrl', 'https://a.example', 'apiKey', 'k', 'authStyle', 'bearer'), '{}', '[]', '[]'),
              ('up_failed', 'custom', 'Failed', 1, 1, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z',
                json_object('baseUrl', 'https://b.example', 'apiKey', 'k', 'authStyle', 'bearer'), '{}', '[]', '[]'),
              ('up_cold', 'custom', 'Cold', 1, 2, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z',
                json_object('baseUrl', 'https://c.example', 'apiKey', 'k', 'authStyle', 'bearer'), '{}', '[]', '[]')`);
    // Revision 4 already carried the core ProviderModel projection below;
    // revision 5 changed pricing semantics. The migration must preserve this
    // faithful old catalog even though current hydration treats it as cold.
    db.run(`INSERT INTO models_cache (upstream_id, revision, fetched_at, models_json, last_error_json)
            VALUES
              ('up_clean', 4, 1785643896263, '[{"id":"cached-model","limits":{},"kind":"chat","endpoints":{"openaiResponses":{}},"enabledFlags":["vendor-deepseek"]}]', NULL),
              ('up_failed', 4, 1785643797798, '[{"id":"stale-model","limits":{},"kind":"chat","endpoints":{"openaiResponses":{}},"enabledFlags":[]}]', '{"message":"boom","at":1785643800000}')`);

    applySqlJsFile(db, '0072_fold_models_cache.sql');

    assertEquals(sqlJsRows<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE name = 'models_cache'"), []);
    const folded = sqlJsRows<{ id: string; models_cache_json: string | null }>(
      db,
      'SELECT id, models_cache_json FROM upstreams ORDER BY id',
    );
    assertEquals(folded.map(row => ({
      id: row.id,
      cache: row.models_cache_json === null ? null : JSON.parse(row.models_cache_json),
    })), [
      {
        id: 'up_clean',
        cache: {
          revision: 4,
          fetchedAt: 1785643896263,
          models: [{ id: 'cached-model', limits: {}, kind: 'chat', endpoints: { openaiResponses: {} }, enabledFlags: ['vendor-deepseek'] }],
          lastError: null,
        },
      },
      { id: 'up_cold', cache: null },
      {
        id: 'up_failed',
        cache: {
          revision: 4,
          fetchedAt: 1785643797798,
          models: [{ id: 'stale-model', limits: {}, kind: 'chat', endpoints: { openaiResponses: {} }, enabledFlags: [] }],
          lastError: { message: 'boom', at: 1785643800000 },
        },
      },
    ]);

    // The folded cache is read back through the production repository, which
    // selects the columns the current schema has, so the rest of the corpus
    // has to land before it can.
    for (const filename of migrationFilenames.filter(f => f > '0072_fold_models_cache.sql').toSorted()) {
      applySqlJsFile(db, filename);
    }

    const repo = new SqlRepo(wrapSqlJsDatabase(db));
    assertEquals((await repo.upstreams.getById('up_clean'))?.modelsCache, {
      revision: 4,
      fetchedAt: 1785643896263,
      lastError: null,
    });
    assertEquals((await repo.upstreams.getById('up_failed'))?.modelsCache, {
      revision: 4,
      fetchedAt: 1785643797798,
      lastError: { message: 'boom', at: 1785643800000, failureCount: 1 },
    });
    assertEquals((await repo.upstreams.getById('up_cold'))?.modelsCache, {
      revision: null,
      fetchedAt: null,
      lastError: null,
    });
    assertEquals(await repo.upstreamModels.listByUpstream('up_clean'), []);
    assertEquals(await repo.upstreamModels.listByUpstream('up_failed'), []);
  } finally {
    db.close();
  }
});

const migrationFilenames = migrationSqlByFilename.map(([filename]) => filename);

const createMigratedSqlJsDatabase = async (): Promise<SqlJsDatabase> => {
  const db = await createSqlJsDatabase();
  for (const filename of migrationFilenames.filter(filename => filename < '0010_unified_upstreams.sql').toSorted()) {
    applySqlJsFile(db, filename);
  }
  return db;
};

const applySqlJsFile = (db: SqlJsDatabase, filename: string): void => {
  const sql = migrationSqlByFilename.find(([candidate]) => candidate === filename)?.[1];
  if (sql === undefined) throw new Error(`Missing migration SQL fixture: ${filename}`);
  db.run(sql);
};

const sqlJsRows = <T>(db: SqlJsDatabase, sql: string): T[] => {
  const [result] = db.exec(sql);
  if (!result) return [];
  return result.values.map(values => Object.fromEntries(result.columns.map((column, index) => [column, values[index] ?? null])) as T);
};

const sqlString = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const inputRates = (input: number, output?: number) => ({
  input_tokens: divideDecimalString(String(input), '1000000'),
  input_cache_read_tokens: divideDecimalString(String(input), '1000000'),
  input_cache_write_tokens: divideDecimalString(String(input), '1000000'),
  input_cache_write_1h_tokens: divideDecimalString(String(input), '1000000'),
  input_image_tokens: divideDecimalString(String(input), '1000000'),
  ...(output === undefined ? {} : {
    output_tokens: divideDecimalString(String(output), '1000000'),
    output_image_tokens: divideDecimalString(String(output), '1000000'),
  }),
});

const tokenPricing = (entries: ModelPricing['entries']): ModelPricing => ({ entries });

test('model pricing migrations materialize legacy semantics as base-unit metric rates', async () => {
  const db = await createSqlJsDatabase();
  for (const [filename, sql] of migrationSqlByFilename) {
    if (filename === '0054_model_pricing.sql') {
      const legacyKey = ['co', 'st'].join('');
      const configJson = JSON.stringify({
        models: [
          {
            upstreamModelId: 'base-and-overlay',
            [legacyKey]: { input: 1, output: 4, tiers: { priority: { input: 2 } } },
          },
          {
            upstreamModelId: 'cache-overrides',
            [legacyKey]: {
              input: 1,
              input_cache_read: 0.1,
              input_cache_write: 1.25,
              output: 4,
              tiers: { fast: { input: 2, input_cache_write: 3 } },
            },
          },
          {
            upstreamModelId: 'tiny-rate',
            [legacyKey]: { input: 1e-20 },
          },
          {
            upstreamModelId: 'tier-adds-output',
            [legacyKey]: { input: 1, tiers: { priority: { output: 8 } } },
          },
          {
            upstreamModelId: 'tier-only',
            [legacyKey]: { tiers: { priority: { input: 2 } } },
          },
          {
            upstreamModelId: 'empty-tier',
            [legacyKey]: { input: 1, tiers: { priority: {} } },
          },
          {
            upstreamModelId: 'empty-rates',
            [legacyKey]: { tiers: { priority: {} } },
          },
          {
            upstreamModelId: 'write-and-output-only',
            [legacyKey]: { input_cache_write: 1.25, output: 4 },
          },
          {
            upstreamModelId: 'zero-input',
            [legacyKey]: { input: 0, tiers: { priority: { input: 2 } } },
          },
          {
            upstreamModelId: 'tier-order',
            [legacyKey]: { input: 1, tiers: { priority: { input: 2 }, flex: { input: 0.5 } } },
          },
          {
            upstreamModelId: 'base-equivalent-tiers',
            [legacyKey]: {
              input: 1,
              tiers: {
                default: { input: 2 },
                '\tDefault\n': { input: 3 },
                '\u00a0standard\u00a0': { output: 8 },
                '\u3000default\u3000': { input: 4 },
                '\t\n': { input: 5 },
              },
            },
          },
          {
            upstreamModelId: 'base-equivalent-tier-only',
            [legacyKey]: { tiers: { Standard: { input: 2 } } },
          },
          { upstreamModelId: 'unpriced', display_name: 'Unpriced' },
        ],
      });
      db.run(
        `INSERT INTO upstreams (id, provider, name, created_at, updated_at, config_json)
         VALUES ('up_pricing', 'custom', 'Pricing migration', '2026-07-13T00:00:00.000Z', '2026-07-13T00:00:00.000Z', ${sqlString(configJson)})`,
      );
    }
    db.run(sql);
  }

  const [configResult] = db.exec("SELECT config_json FROM upstreams WHERE id = 'up_pricing'");
  const config = JSON.parse(configResult!.values[0]![0] as string) as Record<string, unknown>;
  const manualRows = sqlJsRows<{ config_json: string }>(
    db,
    "SELECT config_json FROM upstream_manual_models WHERE upstream_id = 'up_pricing' ORDER BY position",
  );
  const models = manualRows.map(row => JSON.parse(row.config_json) as {
    upstreamModelId: string;
    display_name?: string;
    pricing?: ModelPricing;
  });
  assertEquals(config, {
    apiKey: '',
    ingressHeadersRules: [],
    modelsFetch: { enabled: false, authStyle: 'bearer', endpoint: null },
  });
  assertEquals(models, [
    {
      upstreamModelId: 'base-and-overlay',
      pricing: tokenPricing([
        { rates: inputRates(1, 4) },
        { selector: { serviceTier: 'priority' }, rates: inputRates(2, 4) },
      ]),
    },
    {
      upstreamModelId: 'cache-overrides',
      pricing: tokenPricing([
        {
          rates: {
            input_tokens: '0.000001',
            input_cache_read_tokens: '0.0000001',
            input_cache_write_tokens: '0.00000125',
            input_cache_write_1h_tokens: '0.00000125',
            input_image_tokens: '0.000001',
            output_tokens: '0.000004',
            output_image_tokens: '0.000004',
          },
        },
        {
          selector: { serviceTier: 'fast' },
          rates: {
            input_tokens: '0.000002',
            input_cache_read_tokens: '0.0000001',
            input_cache_write_tokens: '0.000003',
            input_cache_write_1h_tokens: '0.000003',
            input_image_tokens: '0.000002',
            output_tokens: '0.000004',
            output_image_tokens: '0.000004',
          },
        },
      ]),
    },
    {
      upstreamModelId: 'tiny-rate',
      pricing: tokenPricing([{
        rates: {
          input_tokens: '0.00000000000000000000000001',
          input_cache_read_tokens: '0.00000000000000000000000001',
          input_cache_write_tokens: '0.00000000000000000000000001',
          input_cache_write_1h_tokens: '0.00000000000000000000000001',
          input_image_tokens: '0.00000000000000000000000001',
        },
      }]),
    },
    {
      upstreamModelId: 'tier-adds-output',
      pricing: tokenPricing([
        { rates: inputRates(1, 0) },
        { selector: { serviceTier: 'priority' }, rates: inputRates(1, 8) },
      ]),
    },
    {
      upstreamModelId: 'tier-only',
      pricing: tokenPricing([
        { rates: inputRates(0) },
        { selector: { serviceTier: 'priority' }, rates: inputRates(2) },
      ]),
    },
    {
      upstreamModelId: 'empty-tier',
      pricing: tokenPricing([
        { rates: inputRates(1) },
        { selector: { serviceTier: 'priority' }, rates: inputRates(1) },
      ]),
    },
    { upstreamModelId: 'empty-rates' },
    {
      upstreamModelId: 'write-and-output-only',
      pricing: tokenPricing([{ rates: { input_cache_write_tokens: '0.00000125', input_cache_write_1h_tokens: '0.00000125', output_tokens: '0.000004', output_image_tokens: '0.000004' } }]),
    },
    {
      upstreamModelId: 'zero-input',
      pricing: tokenPricing([
        { rates: inputRates(0) },
        { selector: { serviceTier: 'priority' }, rates: inputRates(2) },
      ]),
    },
    {
      upstreamModelId: 'tier-order',
      pricing: tokenPricing([
        { rates: inputRates(1) },
        { selector: { serviceTier: 'priority' }, rates: inputRates(2) },
        { selector: { serviceTier: 'flex' }, rates: inputRates(0.5) },
      ]),
    },
    {
      upstreamModelId: 'base-equivalent-tiers',
      pricing: tokenPricing([{ rates: inputRates(1) }]),
    },
    { upstreamModelId: 'base-equivalent-tier-only' },
    { upstreamModelId: 'unpriced', display_name: 'Unpriced' },
  ]);

  for (const model of models) {
    if (!model.pricing) continue;
    validateModelPricing(model.pricing);
    const base = model.pricing.entries.find(entry => entry.selector === undefined)!.rates;
    assertEquals(priceRequest(model.pricing, { inputTokens: 1, serviceTier: 'unknown' }), { selector: {}, rates: base });
  }
});
