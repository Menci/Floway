import { describe, expect, test } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { createSqliteTestDb, createSqlJsDatabase, migrationSqlByFilename, wrapSqlJsDatabase } from './test-sqlite.ts';
import { saveUpstreamForTest } from './upstreams.ts';
import { MODEL_CATALOG_REVISION } from '../../src/repo/models-cache-contract.ts';
import { SqlRepo } from '../../src/repo/sql.ts';
import type { Repo } from '../../src/repo/types.ts';
import { requestApp, setupAppTest } from '../test-utils/app.ts';
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
    expect(custom!.configVersion).toBe(3);

    const models = await repo.upstreamModels.listByUpstream('up_custom');
    expect(models.map(entry => [entry.model.id, entry.source])).toEqual([
      ['gpt-auto', 'auto'],
      ['gpt-manual', 'manual'],
    ]);
    const manual = await repo.upstreamModels.listManualModels('up_custom');
    expect(manual.map(m => m.upstreamModelId)).toEqual(['gpt-manual-wire']);
    const discovered = await repo.upstreamModels.getCustomDiscovered('up_custom');
    expect(discovered?.map(m => m.upstreamModelId)).toEqual(['gpt-manual-wire', 'gpt-auto-wire']);

    const coldFail = await repo.upstreams.getById('up_cold_fail');
    expect(coldFail!.modelsCache).toEqual({
      revision: MODEL_CATALOG_REVISION,
      fetchedAt: null,
      lastError: { message: 'HTTP 503', at: 1_780_000_000_000, failureCount: 2 },
    });

    const backoffs = await repo.proxyBackoffs.listForUpstream('up_custom');
    expect(backoffs).toHaveLength(1);
    expect(backoffs[0]!.failCount).toBe(2);

    // Deleting the upstream cascades to backoffs and all 3 new child tables.
    expect(await repo.upstreams.delete('up_custom')).toBe(true);
    expect(await repo.proxyBackoffs.listForUpstream('up_custom')).toEqual([]);
    expect(await repo.upstreamModels.listByUpstream('up_custom')).toEqual([]);
    expect(await repo.upstreamModels.listManualModels('up_custom')).toEqual([]);
    expect(await repo.upstreamModels.getCustomDiscovered('up_custom')).toBeNull();
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
    await repo.upstreams.publishModelsRefresh({
      id: 'up_dual_kind',
      configVersion: 1,
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
      await repo.upstreams.publishModelsRefresh({
        id,
        configVersion: 1,
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
      AND m.model_id = p.rest`,
  ).bind(JSON.stringify([{ inputId: 'or/gpt-5', prefix: 'or/', rest: 'gpt-5' }])).all<{ detail: string }>();
  expect(planPrefixed.results.some(row => row.detail.includes('SEARCH m USING INDEX'))).toBe(true);
  expect(planPrefixed.results.some(row => row.detail.includes('SEARCH u USING INDEX'))).toBe(true);
  expect(planPrefixed.results.some(row => row.detail.includes('SCAN m') || row.detail.includes('SCAN u'))).toBe(false);

  const planPrefixLookup = await db.prepare(
    `EXPLAIN QUERY PLAN
     SELECT id FROM upstreams WHERE model_prefix IS NOT NULL AND model_prefix = ?`,
  ).bind('or/').all<{ detail: string }>();
  expect(planPrefixLookup.results.some(row => row.detail.includes('idx_upstreams_model_prefix'))).toBe(true);
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
          models: [manualModel('az-v1', 'Azure V1')],
        },
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
        config: { models: [manualModel('az-v2', 'Azure V2')] },
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
        models: [],
      },
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
          config: { models: [manualModel('shared-model', 'Manual Name')] },
        }),
      });
      expect(overrideResp.status).toBe(200);
      const afterOverride = await repo.upstreamModels.listByUpstream(custom.id);
      expect(afterOverride).toHaveLength(1);
      expect(afterOverride[0]!.source).toBe('manual');
      expect(afterOverride[0]!.model.display_name).toBe('Manual Name');

      // Remove the manual override -> auto model is immediately restored from custom_upstream_discovered_models!
      const clearResp = await requestApp(`/api/upstreams/${custom.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({
          config: { models: [] },
        }),
      });
      expect(clearResp.status).toBe(200);
      const afterClear = await repo.upstreamModels.listByUpstream(custom.id);
      expect(afterClear).toHaveLength(1);
      expect(afterClear[0]!.source).toBe('auto');
      expect(afterClear[0]!.model.id).toBe('shared-model');
    },
  );
});
