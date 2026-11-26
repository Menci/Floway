import { describe, expect, test } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { createSqliteTestDb, createSqlJsDatabase, migrationSqlByFilename, wrapSqlJsDatabase } from './test-sqlite.ts';
import { saveUpstreamForTest } from './upstreams.ts';
import { MODEL_CATALOG_REVISION } from '../../src/repo/models-cache-contract.ts';
import { SqlRepo } from '../../src/repo/sql.ts';
import type { Repo } from '../../src/repo/types.ts';
import { requestApp, setupAppTest } from '../test-utils/app.ts';
import type { SqlDatabase } from '@floway-dev/platform';
import type { UpstreamModelConfig, UpstreamRecord } from '@floway-dev/provider';
import { stubProviderModel, withMockedFetch } from '@floway-dev/test-utils';

const baseUpstream = (overrides: Partial<UpstreamRecord> & Pick<UpstreamRecord, 'id' | 'kind'>): UpstreamRecord => ({
  name: overrides.id,
  enabled: true,
  usageRefreshIntervalMinutes: 0,
  sortOrder: 0,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  config: overrides.kind === 'azure'
    ? { endpoint: 'https://example.openai.azure.com', apiKey: 'az-key' }
    : {
        baseUrl: 'https://custom.example.com',
        apiKey: 'sk-test',
        endpoints: { openaiChatCompletions: {} },
        ingressHeadersRules: [],
        modelsFetch: { enabled: true, authStyle: 'bearer' },
      },
  state: null,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [{ id: 'direct_fetch' }],
  modelPrefix: null,
  hue: 210,
  ...overrides,
});

const factories: [string, () => Promise<Repo>][] = [
  ['memory', async () => new InMemoryRepo()],
  ['SQL', async () => new SqlRepo(await createSqliteTestDb())],
];

test('migration 0102 splits catalogs, manual models, prefixes, and preserves proxy backoffs', async () => {
  const db = await createSqlJsDatabase();
  try {
    db.run('PRAGMA foreign_keys = ON');
    for (const [filename, sql] of migrationSqlByFilename) {
      if (filename === '0102_upstream_models_table.sql') {
        db.run(`
          INSERT INTO proxies (id, name, url, created_at, updated_at, dial_timeout_seconds)
          VALUES ('p_1', 'Proxy 1', 'socks5://198.51.100.1:1080', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', NULL)
        `);
        const customModel = stubProviderModel({ id: 'gpt-manual', upstreamModelId: 'gpt-manual-wire', kind: 'chat' });
        const customAuto = stubProviderModel({ id: 'gpt-auto', upstreamModelId: 'gpt-auto-wire', kind: 'chat' });
        const customDiscovered = [
          { upstreamModelId: 'gpt-manual-wire', publicModelId: 'gpt-manual-wire', kind: 'chat', endpoints: { openaiChatCompletions: {} } },
          { upstreamModelId: 'gpt-auto-wire', publicModelId: 'gpt-auto-wire', kind: 'chat', endpoints: { openaiChatCompletions: {} } },
        ];
        db.run(
          `INSERT INTO upstreams (
             id, provider, name, enabled, sort_order, created_at, updated_at,
             config_json, state_json, flag_overrides, disabled_public_model_ids,
             proxy_fallback_list_json, model_prefix_json, models_cache_json, hue,
             config_version, usage_refresh_interval_minutes
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            'up_custom', 'custom', 'Custom', 1, 0, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z',
            JSON.stringify({
              baseUrl: 'https://custom.example.com',
              apiKey: 'sk',
              endpoints: { openaiChatCompletions: {} },
              ingressHeadersRules: [],
              modelsFetch: { enabled: true, authStyle: 'bearer' },
              models: [{ upstreamModelId: 'gpt-manual-wire', publicModelId: 'gpt-manual', kind: 'chat', endpoints: { openaiChatCompletions: {} } }],
            }),
            null, '{}', '[]', JSON.stringify([{ id: 'p_1' }]),
            JSON.stringify({ prefix: 'or/', addressable: ['unprefixed', 'prefixed'], listed: ['prefixed'] }),
            JSON.stringify({
              revision: MODEL_CATALOG_REVISION,
              fetchedAt: 1_780_000_000_000,
              models: [
                { ...customModel, enabledFlags: [...customModel.enabledFlags] },
                { ...customAuto, enabledFlags: [...customAuto.enabledFlags] },
              ],
              discovered: customDiscovered,
              lastError: null,
            }),
            210, 3, 0,
          ],
        );
        // Cold failure row with legacy fetchedAt = 0 sentinel -> must become fetchedAt = NULL.
        db.run(
          `INSERT INTO upstreams (
             id, provider, name, enabled, sort_order, created_at, updated_at,
             config_json, state_json, flag_overrides, disabled_public_model_ids,
             proxy_fallback_list_json, model_prefix_json, models_cache_json, hue,
             config_version, usage_refresh_interval_minutes
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            'up_cold_fail', 'copilot', 'Cold Fail', 1, 1, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z',
            JSON.stringify({ githubHost: 'github.com', githubToken: 'tok', user: { id: 1, login: 'u', name: null, avatar_url: '' } }),
            null, '{}', '[]', '[]', null,
            JSON.stringify({
              revision: MODEL_CATALOG_REVISION,
              fetchedAt: 0,
              models: [],
              lastError: { message: 'HTTP 503', at: 1_780_000_000_000, failureCount: 2 },
            }),
            120, 1, 0,
          ],
        );
        db.run(`
          INSERT INTO proxy_upstream_backoffs (proxy_id, upstream_id, fail_count, expires_at, last_error, last_error_at)
          VALUES ('p_1', 'up_custom', 2, 9999999999, 'tcp refused', 1780000000)
        `);
      }
      db.run(sql);
    }

    const repo = new SqlRepo(wrapSqlJsDatabase(db));
    const custom = await repo.upstreams.getById('up_custom');
    expect(custom).not.toBeNull();
    expect('models' in (custom!.config as Record<string, unknown>)).toBe(false);
    expect(custom!.modelPrefix).toEqual({ prefix: 'or/', addressable: ['unprefixed', 'prefixed'], listed: ['prefixed'] });
    expect(custom!.modelsCache).toEqual({ revision: MODEL_CATALOG_REVISION, fetchedAt: 1_780_000_000_000, lastError: null });
    expect(custom!.version).toBe(3);

    const models = await repo.upstreamModels.listByUpstream('up_custom');
    expect(models.map(entry => [entry.model.id, entry.source])).toEqual([
      ['gpt-auto', 'auto'],
      ['gpt-manual', 'manual'],
    ]);
    const manual = await repo.upstreamModels.listManualModels('up_custom');
    expect(manual.map(m => m.upstreamModelId)).toEqual(['gpt-manual-wire']);

    const coldFail = await repo.upstreams.getById('up_cold_fail');
    expect(coldFail!.modelsCache).toEqual({
      revision: MODEL_CATALOG_REVISION,
      fetchedAt: null,
      lastError: { message: 'HTTP 503', at: 1_780_000_000_000, failureCount: 2 },
    });

    const backoffs = await repo.proxyBackoffs.listForUpstream('up_custom');
    expect(backoffs).toHaveLength(1);
    expect(backoffs[0]!.failCount).toBe(2);

    // Deleting the upstream cascades to backoffs and both model child tables.
    expect(await repo.upstreams.delete('up_custom')).toBe(true);
    expect(await repo.proxyBackoffs.listForUpstream('up_custom')).toEqual([]);
    expect(await repo.upstreamModels.listByUpstream('up_custom')).toEqual([]);
    expect(await repo.upstreamModels.listManualModels('up_custom')).toEqual([]);
  } finally {
    db.close();
  }
});

describe.each(factories)('%s upstream models repository', (_name, createRepo) => {
  test('resolves unprefixed, prefixed, disabled, and multi-kind same-id models accurately', async () => {
    const repo = await createRepo();
    await saveUpstreamForTest(repo.upstreams, baseUpstream({
      id: 'up_dual_kind',
      kind: 'custom',
      sortOrder: 1,
      disabledPublicModelIds: ['blocked'],
      modelPrefix: { prefix: 'p/', addressable: ['unprefixed', 'prefixed'], listed: ['unprefixed', 'prefixed'] },
    }));
    const insertedDual = (await repo.upstreams.getById('up_dual_kind'))!;
    await repo.upstreams.publishModelsRefresh({
      id: 'up_dual_kind',
      version: insertedDual.version,
      revision: MODEL_CATALOG_REVISION,
      fetchedAt: 1000,
      models: [
        { source: 'auto', model: stubProviderModel({ id: 'shared-id', kind: 'chat', endpoints: { openaiChatCompletions: {} } }) },
        { source: 'auto', model: stubProviderModel({ id: 'shared-id', kind: 'embedding', endpoints: { openaiEmbeddings: {} } }) },
        { source: 'auto', model: stubProviderModel({ id: 'blocked', kind: 'chat', endpoints: { openaiChatCompletions: {} } }) },
      ],
    });

    // Both chat and embedding rows for the same model_id survive and resolve.
    const hits = await repo.upstreamModels.resolve({ modelIds: ['shared-id'], upstreamIds: null });
    expect(hits.map(h => [h.model.id, h.model.kind, h.matchedForm])).toEqual([
      ['shared-id', 'chat', 'unprefixed'],
      ['shared-id', 'embedding', 'unprefixed'],
    ]);

    const prefixedHits = await repo.upstreamModels.resolve({ modelIds: ['p/shared-id'], upstreamIds: null });
    expect(prefixedHits.map(h => [h.model.id, h.model.kind, h.matchedForm])).toEqual([
      ['shared-id', 'chat', 'prefixed'],
      ['shared-id', 'embedding', 'prefixed'],
    ]);

    // Disabled model is excluded in both bare and prefixed forms.
    expect(await repo.upstreamModels.resolve({ modelIds: ['blocked', 'p/blocked'], upstreamIds: null })).toEqual([]);

    // countListedByUpstream counts distinct active model_ids multiplied by listed forms (2x for both).
    const counts = await repo.upstreamModels.countListedByUpstream(['up_dual_kind']);
    expect(counts.get('up_dual_kind')).toBe(2);

    // Updating disabledPublicModelIds syncs upstream_models.disabled immediately without rewriting rows.
    const stored = (await repo.upstreams.getById('up_dual_kind'))!;
    await repo.upstreams.replace({
      previous: stored,
      upstream: { ...stored, disabledPublicModelIds: ['shared-id'] },
    });
    expect(await repo.upstreamModels.resolve({ modelIds: ['shared-id'], upstreamIds: null })).toEqual([]);
    expect((await repo.upstreamModels.resolve({ modelIds: ['blocked'], upstreamIds: null })).map(h => h.model.id)).toEqual(['blocked']);
    expect((await repo.upstreamModels.countListedByUpstream(['up_dual_kind'])).get('up_dual_kind')).toBe(2);

    // getByKey distinguishes kinds on the same (upstream_id, model_id).
    expect((await repo.upstreamModels.getByKey('up_dual_kind', 'shared-id', 'chat'))?.kind).toBe('chat');
    expect((await repo.upstreamModels.getByKey('up_dual_kind', 'shared-id', 'embedding'))?.kind).toBe('embedding');

    // listMeta / listIds / getMetaByIds return scalar metadata in order.
    expect(await repo.upstreams.listIds()).toEqual(['up_dual_kind']);
    expect(await repo.upstreams.listMeta()).toEqual([
      { id: 'up_dual_kind', kind: 'custom', name: 'up_dual_kind', enabled: true, sortOrder: 1, hue: 210 },
    ]);
    expect(await repo.upstreams.getMetaByIds(['up_dual_kind', 'missing'])).toHaveLength(1);
  });

  test('listDueModelsRefresh skips fresh local-only upstreams even past the 10-minute interval', async () => {
    const repo = await createRepo();
    await saveUpstreamForTest(repo.upstreams, baseUpstream({ id: 'up_azure', kind: 'azure', sortOrder: 0 }));
    await saveUpstreamForTest(repo.upstreams, baseUpstream({
      id: 'up_local_custom',
      kind: 'custom',
      sortOrder: 1,
      config: { baseUrl: 'https://a.example', apiKey: 'k', endpoints: {}, ingressHeadersRules: [], modelsFetch: { enabled: false, authStyle: 'bearer' } },
    }));
    await saveUpstreamForTest(repo.upstreams, baseUpstream({ id: 'up_net_custom', kind: 'custom', sortOrder: 2 }));
    await saveUpstreamForTest(repo.upstreams, baseUpstream({ id: 'up_disabled', kind: 'custom', enabled: false, sortOrder: 3 }));

    const t0 = 1_800_000_000_000;
    for (const id of ['up_azure', 'up_local_custom', 'up_net_custom']) {
      const stored = (await repo.upstreams.getById(id))!;
      await repo.upstreams.publishModelsRefresh({
        id,
        version: stored.version,
        revision: MODEL_CATALOG_REVISION,
        fetchedAt: t0,
        models: [],
      });
    }

    // 1 hour later: only the network-backed custom upstream is due.
    const dueAfterHour = await repo.upstreams.listDueModelsRefresh(MODEL_CATALOG_REVISION, t0 + 60 * 60_000);
    expect(dueAfterHour.map(c => [c.id, c.requiresNetwork])).toEqual([['up_net_custom', true]]);

    // On a revision bump: local-only upstreams also become due so projections re-materialize.
    const dueOnBump = await repo.upstreams.listDueModelsRefresh(MODEL_CATALOG_REVISION + 1, t0 + 1_000);
    expect(dueOnBump.map(c => [c.id, c.requiresNetwork])).toEqual([
      ['up_azure', false],
      ['up_local_custom', false],
      ['up_net_custom', true],
    ]);
  });
});

test('SQLite resolve queries use indexes without scanning upstream_models', async () => {
  const db = await createSqliteTestDb();
  const planUnprefixed = await db.prepare(
    `EXPLAIN QUERY PLAN
     SELECT m.model_id, m.model_json
     FROM upstream_models m
     JOIN upstreams u ON u.id = m.upstream_id
     WHERE m.model_id = ?
       AND m.disabled = 0
       AND u.enabled = 1
       AND (u.model_prefix IS NULL OR u.model_prefix_addressable IN ('unprefixed', 'both'))`,
  ).bind('gpt-5').all<{ detail: string }>();
  expect(planUnprefixed.results.some(row => row.detail.includes('idx_upstream_models_model_id'))).toBe(true);
  expect(planUnprefixed.results.some(row => row.detail.includes('SCAN m'))).toBe(false);

  const planPrefixed = await db.prepare(
    `EXPLAIN QUERY PLAN
     SELECT p.input_id, m.model_json, u.id
     FROM (
       SELECT
         CAST(json_extract(value, '$.inputId') AS TEXT) AS input_id,
         CAST(json_extract(value, '$.prefix') AS TEXT) AS prefix,
         CAST(json_extract(value, '$.rest') AS TEXT) AS rest
       FROM json_each(?)
     ) p
     JOIN upstreams u
       ON u.model_prefix IS NOT NULL
      AND u.model_prefix = p.prefix
      AND u.enabled = 1
      AND u.model_prefix_addressable IN ('prefixed', 'both')
     JOIN upstream_models m
       ON m.upstream_id = u.id
      AND m.model_id = p.rest
      AND m.disabled = 0`,
  ).bind(JSON.stringify([{ inputId: 'or/gpt-5', prefix: 'or/', rest: 'gpt-5' }])).all<{ detail: string }>();
  expect(planPrefixed.results.some(row => row.detail.includes('SEARCH m USING INDEX'))).toBe(true);
  expect(planPrefixed.results.some(row => row.detail.includes('SEARCH u USING INDEX'))).toBe(true);
  expect(planPrefixed.results.some(row => row.detail.includes('SCAN m') || row.detail.includes('SCAN u'))).toBe(false);

  const planPrefixLookup = await db.prepare(
    `EXPLAIN QUERY PLAN
     SELECT id FROM upstreams WHERE model_prefix IS NOT NULL AND model_prefix = ?`,
  ).bind('or/').all<{ detail: string }>();
  expect(planPrefixLookup.results.some(row => row.detail.includes('idx_upstreams_model_prefix'))).toBe(true);

  const planCountListed = await db.prepare(
    `EXPLAIN QUERY PLAN
     SELECT COUNT(DISTINCT m.model_id)
     FROM upstream_models m
     WHERE m.upstream_id = ?
       AND m.disabled = 0`,
  ).bind('up_0').all<{ detail: string }>();
  expect(planCountListed.results.some(row => row.detail.includes('COVERING INDEX idx_upstream_models_upstream_active'))).toBe(true);

  const planAddressableIds = await db.prepare(
    `EXPLAIN QUERY PLAN
     SELECT DISTINCT
       m.upstream_id,
       m.model_id,
       u.model_prefix,
       u.model_prefix_addressable
     FROM upstream_models m
     JOIN upstreams u ON u.id = m.upstream_id
     WHERE u.enabled = 1
       AND m.disabled = 0
       AND u.id IN (SELECT CAST(value AS TEXT) FROM json_each(?))`,
  ).bind(JSON.stringify(['up_0', 'up_1'])).all<{ detail: string }>();
  expect(planAddressableIds.results.some(row => row.detail.includes('COVERING INDEX idx_upstream_models_upstream_active'))).toBe(true);

  const planCatalogModels = await db.prepare(
    `EXPLAIN QUERY PLAN
     SELECT m.upstream_id, m.model_json
     FROM upstream_models m
     JOIN upstreams u ON u.id = m.upstream_id
     WHERE u.enabled = 1
       AND m.disabled = 0`,
  ).all<{ detail: string }>();
  expect(planCatalogModels.results.some(row => row.detail.includes('TEMP B-TREE'))).toBe(false);
});

test('SQLite publishModelsRefresh writes zero upstream_models changes when unchanged and only diffs on mutation', async () => {
  const db = await createSqliteTestDb();
  const batchChanges: number[][] = [];
  const spiedDb: SqlDatabase = {
    prepare: sql => db.prepare(sql),
    exec: sql => db.exec(sql),
    batch: async statements => {
      const results = await db.batch!(statements);
      batchChanges.push(results.map(r => r.meta.changes ?? 0));
      return results;
    },
  };
  const repo = new SqlRepo(spiedDb);
  await saveUpstreamForTest(repo.upstreams, baseUpstream({ id: 'up_diff', kind: 'custom' }));
  const initial = (await repo.upstreams.getById('up_diff'))!;

  const m1 = stubProviderModel({ id: 'm1', display_name: 'Model 1', enabledFlags: new Set(['vendor-kimi', 'vendor-deepseek'] as const) });
  const m2 = stubProviderModel({ id: 'm2', display_name: 'Model 2', limits: { max_output_tokens: 4096, max_context_window_tokens: 64000 } });
  const m3 = stubProviderModel({ id: 'm3', display_name: 'Model 3' });
  const m4 = stubProviderModel({ id: 'm4', display_name: 'Model 4' });

  batchChanges.length = 0;
  const v1 = await repo.upstreams.publishModelsRefresh({
    id: 'up_diff',
    version: initial.version,
    revision: MODEL_CATALOG_REVISION,
    fetchedAt: 1_000,
    models: [m1, m2, m3, m4].map(model => ({ source: 'auto', model })),
  });
  expect(v1).not.toBeNull();
  // [update upstreams=1, delete=0, upsert=4]
  expect(batchChanges).toEqual([[1, 0, 4]]);

  // Re-publish logically identical models with reversed key / Set insertion order.
  const m1Reordered = stubProviderModel({ id: 'm1', display_name: 'Model 1', enabledFlags: new Set(['vendor-deepseek', 'vendor-kimi'] as const) });
  const m2Reordered = stubProviderModel({ id: 'm2', display_name: 'Model 2', limits: { max_context_window_tokens: 64000, max_output_tokens: 4096 } });
  batchChanges.length = 0;
  const v2 = await repo.upstreams.publishModelsRefresh({
    id: 'up_diff',
    version: v1!,
    revision: MODEL_CATALOG_REVISION,
    fetchedAt: 2_000,
    models: [m1Reordered, m2Reordered, m3, m4].map(model => ({ source: 'auto', model })),
  });
  expect(v2).not.toBeNull();
  // Zero upstream_models row modifications; only the upstreams fetched_at row updates.
  expect(batchChanges).toEqual([[1, 0, 0]]);

  // Incremental diff: remove m1, keep m2 & m4 unchanged, modify m3, add m5.
  const m3Updated = stubProviderModel({ id: 'm3', display_name: 'Model 3 v2' });
  const m5 = stubProviderModel({ id: 'm5', display_name: 'Model 5' });
  batchChanges.length = 0;
  const v3 = await repo.upstreams.publishModelsRefresh({
    id: 'up_diff',
    version: v2!,
    revision: MODEL_CATALOG_REVISION,
    fetchedAt: 3_000,
    models: [m2, m3Updated, m4, m5].map(model => ({ source: 'auto', model })),
  });
  expect(v3).not.toBeNull();
  // [update upstreams=1, delete=1 (m1), upsert=2 (m3 updated + m5 inserted)]
  expect(batchChanges).toEqual([[1, 1, 2]]);
  expect((await repo.upstreamModels.listByUpstream('up_diff')).map(e => [e.model.id, e.model.display_name])).toEqual([
    ['m2', 'Model 2'],
    ['m3', 'Model 3 v2'],
    ['m4', 'Model 4'],
    ['m5', 'Model 5'],
  ]);

  // Empty publish deletes all 4 remaining rows.
  batchChanges.length = 0;
  const v4 = await repo.upstreams.publishModelsRefresh({
    id: 'up_diff',
    version: v3!,
    revision: MODEL_CATALOG_REVISION,
    fetchedAt: 4_000,
    models: [],
  });
  expect(v4).not.toBeNull();
  expect(batchChanges).toEqual([[1, 4]]);
  expect(await repo.upstreamModels.listByUpstream('up_diff')).toEqual([]);
});

test('scoped non-admin /v1/models pre-prunes upstreams, honors model rules, preserves gateway-wide alias metadata, and short-circuits upstream-options', async () => {
  const { repo, apiKey: scopedKey } = await setupAppTest();
  await repo.modelAliases.deleteAll();
  await repo.upstreams.deleteAll();

  for (const [id, sortOrder, models] of [
    ['up_a', 0, [
      stubProviderModel({ id: 'gpt-5', limits: { max_context_window_tokens: 128_000, max_output_tokens: 16_000 }, endpoints: { openaiChatCompletions: {} } }),
      stubProviderModel({ id: 'claude-sonnet', limits: { max_context_window_tokens: 200_000 }, endpoints: { openaiChatCompletions: {} } }),
    ]],
    ['up_b', 1, [
      stubProviderModel({ id: 'gpt-5', limits: { max_context_window_tokens: 64_000, max_output_tokens: 8_000 }, endpoints: { openaiChatCompletions: {}, openaiResponses: {} } }),
      stubProviderModel({ id: 'gemini-pro', limits: { max_context_window_tokens: 1_000_000 }, endpoints: { openaiChatCompletions: {} } }),
    ]],
    ['up_c', 2, [
      stubProviderModel({ id: 'secret-alpha', limits: { max_context_window_tokens: 32_000 }, endpoints: { openaiChatCompletions: {} } }),
      stubProviderModel({ id: 'other-model', limits: { max_context_window_tokens: 32_000 }, endpoints: { openaiChatCompletions: {} } }),
    ]],
  ] as const) {
    await saveUpstreamForTest(repo.upstreams, baseUpstream({ id, kind: 'custom', sortOrder }));
    const stored = (await repo.upstreams.getById(id))!;
    await repo.upstreams.publishModelsRefresh({
      id,
      version: stored.version,
      revision: MODEL_CATALOG_REVISION,
      fetchedAt: 1_800_000_000_000,
      models: models.map(model => ({ source: 'auto', model })),
    });
  }

  await repo.modelAliases.insert({
    id: 'alias_smart',
    name: 'smart',
    displayName: 'Smart Alias',
    kind: 'chat',
    selection: 'first-available',
    targets: [{ target_model_id: 'gpt-5', rules: {} }],
    announcedMetadata: null,
    visibleInModelsList: true,
    sortOrder: 0,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  });

  await repo.apiKeys.save({
    id: 'admin-key-test',
    userId: 1,
    name: 'Admin Key',
    key: 'sk-admin-key-test',
    serverSecret: '00'.repeat(32),
    createdAt: '2026-09-01T00:00:00.000Z',
    upstreamIds: null,
    deletedAt: null,
    dumpRetentionSeconds: null,
    openaiResponsesRetentionSeconds: 0,
    randomizeUpstreams: false,
  });

  const scopedSession = await repo.sessions.create(scopedKey.userId);
  await repo.accessRecords.deleteByPrincipal({ kind: 'user', id: scopedKey.userId });

  // Grant: whole up_a except claude-sonnet; regex ^secret- on up_c; nothing on up_b.
  await repo.accessRecords.save({
    principal: { kind: 'user', id: scopedKey.userId },
    scope: { kind: 'upstream', upstreamId: 'up_a' },
    sortOrder: 0,
    values: { 'Model.Use': true },
  });
  await repo.accessRecords.save({
    principal: { kind: 'user', id: scopedKey.userId },
    scope: { kind: 'upstreamModel', upstreamId: 'up_a', model: { kind: 'exact', value: 'claude-sonnet' } },
    sortOrder: 0,
    values: { 'Model.Use': false },
  });
  await repo.accessRecords.save({
    principal: { kind: 'user', id: scopedKey.userId },
    scope: { kind: 'upstreamModel', upstreamId: 'up_c', model: { kind: 'regex', value: '^secret-' } },
    sortOrder: 0,
    values: { 'Model.Use': true },
  });

  const [adminResp, scopedResp, optionsResp] = await Promise.all([
    requestApp('/v1/models', { headers: { 'x-api-key': 'sk-admin-key-test' } }),
    requestApp('/v1/models', { headers: { 'x-api-key': scopedKey.key } }),
    requestApp('/api/upstream-options?view=key', { headers: { 'x-floway-session': scopedSession.id } }),
  ]);
  expect(adminResp.status).toBe(200);
  expect(scopedResp.status).toBe(200);
  expect(optionsResp.status).toBe(200);

  const adminModels = ((await adminResp.json()) as { data: Array<{ id: string; limits: unknown; endpoints: unknown }> }).data;
  const scopedModels = ((await scopedResp.json()) as { data: Array<{ id: string; limits: unknown; endpoints: unknown }> }).data;
  expect(scopedModels.map(m => m.id)).toEqual(['gpt-5', 'secret-alpha', 'smart']);

  // Alias `smart` must announce the exact same gateway-wide metadata (including up_b's openaiResponses endpoint)
  // to scopedUser as it does to admin.
  const adminSmart = adminModels.find(m => m.id === 'smart')!;
  const scopedSmart = scopedModels.find(m => m.id === 'smart')!;
  expect(scopedSmart.limits).toEqual(adminSmart.limits);
  expect(scopedSmart.endpoints).toEqual(adminSmart.endpoints);

  // `upstream-options?view=key` surfaces up_a (upstream grant) and up_c (regex model grant), never up_b.
  const options = await optionsResp.json() as Array<{ id: string }>;
  expect(options.map(o => o.id)).toEqual(['up_a', 'up_c']);

  // Now also verify global grant + upstream-level deny pruning.
  await repo.accessRecords.deleteByPrincipal({ kind: 'user', id: scopedKey.userId });
  await repo.accessRecords.save({
    principal: { kind: 'user', id: scopedKey.userId },
    scope: { kind: 'upstreams' },
    sortOrder: 0,
    values: { 'Model.Use': true },
  });
  await repo.accessRecords.save({
    principal: { kind: 'user', id: scopedKey.userId },
    scope: { kind: 'upstream', upstreamId: 'up_b' },
    sortOrder: 0,
    values: { 'Model.Use': false },
  });
  const globalDeniedResp = await requestApp('/v1/models', { headers: { 'x-api-key': scopedKey.key } });
  expect(globalDeniedResp.status).toBe(200);
  const globalDeniedIds = ((await globalDeniedResp.json()) as { data: Array<{ id: string }> }).data.map(m => m.id);
  expect(globalDeniedIds).toEqual(['claude-sonnet', 'gpt-5', 'other-model', 'secret-alpha', 'smart']);
});

test('saving manual models materializes immediately with zero 404 window and restores shadowed custom auto models on removal', async () => {
  const { repo, adminSession, apiKey } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const headers = { 'content-type': 'application/json', 'x-floway-session': adminSession };
  const manualModel = (upstreamModelId: string, displayName: string): UpstreamModelConfig => ({
    upstreamModelId,
    kind: 'chat',
    endpoints: { openaiChatCompletions: {} },
    display_name: displayName,
  });

  // 1. Azure create + edit: immediately listed without any network call.
  const azureCreate = await withMockedFetch(
    request => { throw new Error(`Azure save must not fetch ${request.url}`); },
    () => requestApp('/api/upstreams', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        kind: 'azure',
        name: 'Azure',
        hue: 210,
        config: {
          endpoint: 'https://example.openai.azure.com',
          apiKey: 'az-key',
        },
        manual_models: [manualModel('az-v1', 'Azure V1')],
        proxy_fallback_list: [{ id: 'direct_fetch' }],
      }),
    }),
  );
  expect(azureCreate.status).toBe(201);
  const azure = await azureCreate.json() as { id: string; modelsCache: { modelCount: number } };
  expect(azure.modelsCache.modelCount).toBe(1);

  const listAfterCreate = await requestApp('/v1/models', { headers: { 'x-api-key': apiKey.key } });
  expect(((await listAfterCreate.json()) as { data: { id: string }[] }).data.map(m => m.id)).toEqual(['az-v1']);

  const azurePatch = await withMockedFetch(
    request => { throw new Error(`Azure patch must not fetch ${request.url}`); },
    () => requestApp(`/api/upstreams/${azure.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        manual_models: [manualModel('az-v2', 'Azure V2')],
      }),
    }),
  );
  expect(azurePatch.status).toBe(200);
  const listAfterPatch = await requestApp('/v1/models', { headers: { 'x-api-key': apiKey.key } });
  expect(((await listAfterPatch.json()) as { data: { id: string }[] }).data.map(m => m.id)).toEqual(['az-v2']);

  // 2. Custom with modelsFetch enabled: override auto model then delete override -> auto model restores synchronously!
  const customCreate = await requestApp('/api/upstreams', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      kind: 'custom',
      name: 'Custom',
      hue: 120,
      config: {
        baseUrl: 'https://custom.example.com',
        apiKey: 'sk-custom',
        endpoints: { openaiChatCompletions: {} },
        ingressHeadersRules: [],
        modelsFetch: { enabled: true, authStyle: 'bearer' },
      },
      manual_models: [],
      proxy_fallback_list: [{ id: 'direct_fetch' }],
    }),
  });
  expect(customCreate.status).toBe(201);
  const custom = await customCreate.json() as { id: string };

  await withMockedFetch(
    () => Response.json({ object: 'list', data: [{ id: 'shared-model', display_name: 'Auto Name' }] }),
    async () => {
      const fetchResp = await requestApp(`/api/upstreams/${custom.id}/list-models`, {
        method: 'POST',
        headers: { 'x-floway-session': adminSession },
      });
      expect(fetchResp.status).toBe(200);
    },
  );

  // Add a manual override -> takes effect immediately with zero network fetch.
  await withMockedFetch(
    request => { throw new Error(`Manual override edit must not fetch ${request.url}`); },
    async () => {
      const overrideResp = await requestApp(`/api/upstreams/${custom.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({
          manual_models: [manualModel('shared-model', 'Manual Name')],
        }),
      });
      expect(overrideResp.status).toBe(200);
      const afterOverride = await repo.upstreamModels.listByUpstream(custom.id);
      expect(afterOverride).toHaveLength(1);
      expect(afterOverride[0]!.source).toBe('manual');
      expect(afterOverride[0]!.model.display_name).toBe('Manual Name');

      // Remove the manual override -> manual row is removed and cache is marked stale for the next refresh.
      const clearResp = await requestApp(`/api/upstreams/${custom.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({
          manual_models: [],
        }),
      });
      expect(clearResp.status).toBe(200);
      expect(await repo.upstreamModels.listByUpstream(custom.id)).toEqual([]);
      expect((await repo.upstreams.getById(custom.id))?.modelsCache.revision).toBeNull();
    },
  );
  // Next catalog refresh restores the unshadowed auto model.
  await withMockedFetch(
    () => Response.json({ object: 'list', data: [{ id: 'shared-model', display_name: 'Auto Name' }] }),
    async () => {
      const fetchResp = await requestApp(`/api/upstreams/${custom.id}/list-models`, {
        method: 'POST',
        headers: { 'x-floway-session': adminSession },
      });
      expect(fetchResp.status).toBe(200);
      const afterRefresh = await repo.upstreamModels.listByUpstream(custom.id);
      expect(afterRefresh).toHaveLength(1);
      expect(afterRefresh[0]!.source).toBe('auto');
      expect(afterRefresh[0]!.model.id).toBe('shared-model');
    },
  );
});
