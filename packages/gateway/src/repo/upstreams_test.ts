import initSqlJs from 'sql.js';
import { test } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { SqlRepo } from './sql.ts';
import type { UpstreamRepo } from './types.ts';
import type { SqlDatabase } from '@floway-dev/platform';
import type { UpstreamRecord } from '@floway-dev/provider';
import { assert, assertEquals, assertRejects } from '@floway-dev/test-utils';

const upstream = (overrides: Partial<UpstreamRecord> & Pick<UpstreamRecord, 'id' | 'kind' | 'createdAt' | 'sortOrder'>): UpstreamRecord => ({
  name: overrides.id,
  enabled: true,
  updatedAt: overrides.createdAt,
  config: { nested: { value: overrides.id }, endpoints: { chatCompletions: {} } },
  state: null,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  color: null,
  ...overrides,
});

test('memory upstream repo saves, lists, updates, deletes, and clears rows', async () => {
  const repo = new InMemoryRepo().upstreams;

  const custom = upstream({
    id: 'up_custom_a',
    kind: 'custom',
    name: 'Custom A',
    sortOrder: 2,
    createdAt: '2026-05-21T10:00:02.000Z',
    updatedAt: '2026-05-21T10:00:02.000Z',
  });
  const copilot = upstream({
    id: 'up_copilot_a',
    kind: 'copilot',
    name: 'Copilot A',
    sortOrder: 1,
    createdAt: '2026-05-21T10:00:03.000Z',
    updatedAt: '2026-05-21T10:00:03.000Z',
  });
  const azure = upstream({
    id: 'up_azure_a',
    kind: 'azure',
    name: 'Azure A',
    sortOrder: 1,
    createdAt: '2026-05-21T10:00:01.000Z',
    updatedAt: '2026-05-21T10:00:01.000Z',
  });

  await repo.save(custom);
  await repo.save(copilot);
  await repo.save(azure);

  assertEquals(
    (await repo.list()).map(row => row.id),
    ['up_azure_a', 'up_copilot_a', 'up_custom_a'],
  );

  assertEquals(await repo.getById('up_custom_a'), custom);
  assertEquals(await repo.getById('missing'), null);

  const updatedCustom = upstream({
    ...custom,
    name: 'Custom A Updated',
    enabled: false,
    sortOrder: 0,
    createdAt: '2099-01-01T00:00:00.000Z',
    updatedAt: '2026-05-21T10:00:04.000Z',
    config: { nested: { value: 'updated' }, endpoints: { responses: {} } },
    flagOverrides: { 'retry-cyber-policy': true },
    disabledPublicModelIds: [],
  });
  await repo.save(updatedCustom);

  assertEquals(
    (await repo.list()).map(row => [row.id, row.name, row.enabled]),
    [
      ['up_custom_a', 'Custom A Updated', false],
      ['up_azure_a', 'Azure A', true],
      ['up_copilot_a', 'Copilot A', true],
    ],
  );
  assertEquals((await repo.getById('up_custom_a'))?.createdAt, '2026-05-21T10:00:02.000Z');
  assertEquals(await repo.delete('up_azure_a'), true);
  assertEquals(await repo.delete('up_azure_a'), false);
  assertEquals(
    (await repo.list()).map(row => row.id),
    ['up_custom_a', 'up_copilot_a'],
  );

  await repo.deleteAll();
  assertEquals(await repo.list(), []);
});

test('memory upstream repo deeply clones configs and flag overrides at the repo boundary', async () => {
  const repo = new InMemoryRepo().upstreams;
  const original = upstream({
    id: 'up_custom_clone',
    kind: 'custom',
    sortOrder: 0,
    createdAt: '2026-05-21T10:00:00.000Z',
    config: {
      nested: {
        baseUrl: 'https://example.test/v1',
        headers: ['authorization'],
      },
    },
    flagOverrides: { 'vendor-deepseek': true, 'demote-developer-to-system': true },
    disabledPublicModelIds: [],
  });

  await repo.save(original);
  original.flagOverrides['strip-billing-attribution'] = true;
  (original.config as { nested: { headers: string[] } }).nested.headers.push('mutated-after-save');

  const saved = await repo.getById('up_custom_clone');
  assertEquals(saved?.flagOverrides, { 'demote-developer-to-system': true, 'vendor-deepseek': true });
  assertEquals(saved?.config, {
    nested: {
      baseUrl: 'https://example.test/v1',
      headers: ['authorization'],
    },
  });

  const listed = await repo.list();
  listed[0].flagOverrides['responses-web-search-shim'] = true;
  (listed[0].config as { nested: { headers: string[] } }).nested.headers.push('mutated-after-list');

  assertEquals((await repo.getById('up_custom_clone'))?.flagOverrides, { 'demote-developer-to-system': true, 'vendor-deepseek': true });
  assertEquals((await repo.getById('up_custom_clone'))?.config, {
    nested: {
      baseUrl: 'https://example.test/v1',
      headers: ['authorization'],
    },
  });
});

test('memory upstream repo sorts flag overrides by key when saving rows', async () => {
  const repo = new InMemoryRepo().upstreams;

  await repo.save(
    upstream({
      id: 'up_copilot_fixes',
      kind: 'copilot',
      sortOrder: 0,
      createdAt: '2026-05-21T10:00:00.000Z',
      flagOverrides: { 'vendor-deepseek': true, 'demote-developer-to-system': false, 'messages-web-search-shim': true },
      disabledPublicModelIds: [],
    }),
  );

  assertEquals((await repo.getById('up_copilot_fixes'))?.flagOverrides, { 'demote-developer-to-system': false, 'messages-web-search-shim': true, 'vendor-deepseek': true });
});

const exerciseSqlUpstreamRepo = async (repo: UpstreamRepo) => {
  const custom = upstream({
    id: 'up_custom_sql',
    kind: 'custom',
    name: 'Custom SQL',
    sortOrder: 2,
    createdAt: '2026-05-21T10:00:02.000Z',
    updatedAt: '2026-05-21T10:00:02.000Z',
    config: { baseUrl: 'https://custom.example/v1', authStyle: 'bearer', apiKey: 'sk-custom', endpoints: { chatCompletions: {} } },
    flagOverrides: { 'vendor-deepseek': true, 'demote-developer-to-system': true },
    disabledPublicModelIds: [],
  });
  const copilot = upstream({
    id: 'up_copilot_sql',
    kind: 'copilot',
    name: 'Copilot SQL',
    sortOrder: 1,
    createdAt: '2026-05-21T10:00:03.000Z',
    updatedAt: '2026-05-21T10:00:03.000Z',
    config: { githubToken: 'gho_d1', user: { id: 1, login: 'copilot', name: null, avatar_url: 'https://avatars.test/1.png' } },
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

  await repo.save(custom);
  await repo.save(copilot);
  await repo.save(azure);

  assertEquals(
    (await repo.list()).map(row => row.id),
    ['up_azure_sql', 'up_copilot_sql', 'up_custom_sql'],
  );
  assertEquals((await repo.getById('up_custom_sql'))?.flagOverrides, { 'demote-developer-to-system': true, 'vendor-deepseek': true });
  assertEquals(await repo.getById('missing'), null);

  await repo.save({
    ...custom,
    name: 'Custom SQL Updated',
    enabled: false,
    sortOrder: 0,
    createdAt: '2099-01-01T00:00:00.000Z',
    updatedAt: '2026-05-21T10:00:04.000Z',
    config: { baseUrl: 'https://updated.example/v1', authStyle: 'bearer', apiKey: 'sk-updated', endpoints: { responses: {} } },
    flagOverrides: { 'messages-web-search-shim': true, 'demote-developer-to-system': true },
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

test('SQL upstream repo saves, lists, updates, deletes, and clears rows', async () => {
  await exerciseSqlUpstreamRepo(new SqlRepo(new FakeUpstreamsSqlDatabase()).upstreams);
});

test('SQL upstream repo rejects malformed stored upstream JSON', async () => {
  const db = new FakeUpstreamsSqlDatabase();
  db.rows.push({
    id: 'up_bad_config',
    provider: 'custom',
    name: 'Bad Config',
    enabled: 1,
    sort_order: 0,
    created_at: '2026-05-21T10:00:00.000Z',
    updated_at: '2026-05-21T10:00:00.000Z',
    config_json: '{bad json',
    state_json: null,
    flag_overrides: '{}',
    disabled_public_model_ids: '[]',
    proxy_fallback_list_json: '[]',
    model_prefix_json: null,
    color: null,
  });

  await assertRejects(() => new SqlRepo(db).upstreams.list(), Error, 'Malformed upstream config JSON for up_bad_config');
});

test('SQL upstream repo rejects malformed stored flag overrides JSON', async () => {
  const db = new FakeUpstreamsSqlDatabase();
  db.rows.push({
    id: 'up_bad_fixes',
    provider: 'custom',
    name: 'Bad Fixes',
    enabled: 1,
    sort_order: 0,
    created_at: '2026-05-21T10:00:00.000Z',
    updated_at: '2026-05-21T10:00:00.000Z',
    config_json: '{}',
    state_json: null,
    flag_overrides: '{bad json',
    disabled_public_model_ids: '[]',
    proxy_fallback_list_json: '[]',
    model_prefix_json: null,
    color: null,
  });

  await assertRejects(() => new SqlRepo(db).upstreams.getById('up_bad_fixes'), Error, 'Malformed upstream flag_overrides JSON for up_bad_fixes');
});

test('SQL upstream repo rejects array-shaped flag_overrides with helpful message', async () => {
  const db = new FakeUpstreamsSqlDatabase();
  db.rows.push({
    id: 'up_array_fixes',
    provider: 'custom',
    name: 'Array Fixes',
    enabled: 1,
    sort_order: 0,
    created_at: '2026-05-21T10:00:00.000Z',
    updated_at: '2026-05-21T10:00:00.000Z',
    config_json: '{}',
    state_json: null,
    flag_overrides: '[]',
    disabled_public_model_ids: '[]',
    proxy_fallback_list_json: '[]',
    model_prefix_json: null,
    color: null,
  });

  await assertRejects(
    () => new SqlRepo(db).upstreams.getById('up_array_fixes'),
    Error,
    'Upstream up_array_fixes flag_overrides must be a JSON object, got array',
  );
});

test('SQL upstream repo rejects non-boolean value in flag_overrides with helpful message', async () => {
  const db = new FakeUpstreamsSqlDatabase();
  db.rows.push({
    id: 'up_nonbool_fixes',
    provider: 'custom',
    name: 'Non-boolean Fixes',
    enabled: 1,
    sort_order: 0,
    created_at: '2026-05-21T10:00:00.000Z',
    updated_at: '2026-05-21T10:00:00.000Z',
    config_json: '{}',
    state_json: null,
    flag_overrides: '{"x": 1}',
    disabled_public_model_ids: '[]',
    proxy_fallback_list_json: '[]',
    model_prefix_json: null,
    color: null,
  });

  await assertRejects(
    () => new SqlRepo(db).upstreams.getById('up_nonbool_fixes'),
    Error,
    'Upstream up_nonbool_fixes flag_overrides["x"] must be a boolean, got number',
  );
});

test('SQL upstream repo rejects malformed stored model_prefix_json', async () => {
  const db = new FakeUpstreamsSqlDatabase();
  db.rows.push({
    id: 'up_bad_prefix_json',
    provider: 'custom',
    name: 'Bad Prefix JSON',
    enabled: 1,
    sort_order: 0,
    created_at: '2026-05-21T10:00:00.000Z',
    updated_at: '2026-05-21T10:00:00.000Z',
    config_json: '{}',
    state_json: null,
    flag_overrides: '{}',
    disabled_public_model_ids: '[]',
    proxy_fallback_list_json: '[]',
    model_prefix_json: '{not json',
    color: null,
  });

  await assertRejects(() => new SqlRepo(db).upstreams.getById('up_bad_prefix_json'), Error, 'Malformed upstream model_prefix_json for up_bad_prefix_json');
});

test('SQL upstream repo rejects shape-invalid model_prefix_json', async () => {
  const db = new FakeUpstreamsSqlDatabase();
  db.rows.push({
    id: 'up_bad_prefix_shape',
    provider: 'custom',
    name: 'Bad Prefix Shape',
    enabled: 1,
    sort_order: 0,
    created_at: '2026-05-21T10:00:00.000Z',
    updated_at: '2026-05-21T10:00:00.000Z',
    config_json: '{}',
    state_json: null,
    flag_overrides: '{}',
    disabled_public_model_ids: '[]',
    proxy_fallback_list_json: '[]',
    // Prefix missing trailing slash — passes JSON.parse but fails the regex.
    model_prefix_json: '{"prefix":"or","addressable":["unprefixed"],"listed":[]}',
    color: null,
  });

  await assertRejects(() => new SqlRepo(db).upstreams.getById('up_bad_prefix_shape'), Error, 'Invalid upstream model_prefix_json shape for up_bad_prefix_shape');
});

test('SQL upstream repo round-trips a non-null model_prefix', async () => {
  const db = new FakeUpstreamsSqlDatabase();
  const repo = new SqlRepo(db).upstreams;
  const now = new Date().toISOString();
  const record: UpstreamRecord = {
    id: 'up_prefix_rt',
    kind: 'custom',
    name: 'Prefix Round-Trip',
    enabled: true,
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
    config: { baseUrl: 'https://example.com', bearerToken: 'sk', authStyle: 'bearer', endpoints: { chatCompletions: {} }, modelsFetch: { enabled: true } },
    state: null,
    flagOverrides: {},
    disabledPublicModelIds: [],
    proxyFallbackList: [],
    modelPrefix: { prefix: 'or/', addressable: ['unprefixed', 'prefixed'], listed: ['prefixed'] },
    color: null,
  };
  await repo.save(record);
  const reloaded = await repo.getById('up_prefix_rt');
  assertEquals(reloaded?.modelPrefix, { prefix: 'or/', addressable: ['unprefixed', 'prefixed'], listed: ['prefixed'] });
});

test('SQL upstream repo round-trips a preset color and a hex color', async () => {
  const repo = new SqlRepo(new FakeUpstreamsSqlDatabase()).upstreams;
  await repo.save(upstream({
    id: 'up_color_preset',
    kind: 'custom',
    sortOrder: 0,
    createdAt: '2026-07-01T00:00:00.000Z',
    color: 'emerald',
  }));
  await repo.save(upstream({
    id: 'up_color_hex',
    kind: 'custom',
    sortOrder: 1,
    createdAt: '2026-07-01T00:00:01.000Z',
    color: '#8B5CF6',
  }));

  assertEquals((await repo.getById('up_color_preset'))?.color, 'emerald');
  assertEquals((await repo.getById('up_color_hex'))?.color, '#8B5CF6');
});

test('SQL upstream repo rejects an invalid stored color', async () => {
  const db = new FakeUpstreamsSqlDatabase();
  db.rows.push({
    id: 'up_bad_color',
    provider: 'custom',
    name: 'Bad Color',
    enabled: 1,
    sort_order: 0,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    config_json: '{}',
    state_json: null,
    flag_overrides: '{}',
    disabled_public_model_ids: '[]',
    proxy_fallback_list_json: '[]',
    model_prefix_json: null,
    color: 'not-a-tone',
  });

  await assertRejects(() => new SqlRepo(db).upstreams.getById('up_bad_color'), Error, 'Invalid upstream color for up_bad_color');
});

test('migration 0010 creates unified upstreams and rewrites legacy upstream identities', async () => {
  const db = await createMigratedSqlJsDatabase();
  try {
    seedLegacyUpstreamData(db);
    applySqlJsFile(db, '0010_unified_upstreams.sql');

    const copilotRows = sqlJsRows<{ id: string; sortOrder: number; userId: number; githubToken: string; accountType: string }>(
      db,
      `SELECT
        id,
        sort_order AS sortOrder,
        json_extract(config_json, '$.user.id') AS userId,
        json_extract(config_json, '$.githubToken') AS githubToken,
        json_extract(config_json, '$.accountType') AS accountType
       FROM upstreams
       WHERE provider = 'copilot'
       ORDER BY sort_order, userId`,
    );
    const customRows = sqlJsRows<{ id: string; sortOrder: number; baseUrl: string; bearerToken: string; firstEndpoint: string; chatPath: string }>(
      db,
      `SELECT
        id,
        sort_order AS sortOrder,
        json_extract(config_json, '$.baseUrl') AS baseUrl,
        json_extract(config_json, '$.bearerToken') AS bearerToken,
        json_extract(config_json, '$.supportedEndpoints[0]') AS firstEndpoint,
        json_extract(config_json, '$.pathOverrides.chat_completions') AS chatPath
       FROM upstreams
       WHERE provider = 'custom'`,
    );

    assertEquals(
      copilotRows.map(row => row.userId),
      [2, 1],
    );
    assert(copilotRows.every(row => /^up_[0-9a-f]{24}$/.test(row.id) && !row.id.includes('copilot')));
    assertEquals(copilotRows.map(row => row.githubToken), ['gho_two', 'gho_one']);
    assertEquals(copilotRows.map(row => row.accountType), ['business', 'individual']);

    assertEquals(customRows, [
      {
        id: 'up_custom_existing',
        sortOrder: customRows[0].sortOrder,
        baseUrl: 'https://custom.example/v1',
        bearerToken: 'sk-custom',
        firstEndpoint: '/chat/completions',
        chatPath: '/chat/completions',
      },
    ]);
    assert(customRows[0].sortOrder > copilotRows[1].sortOrder);

    const userTwoUpstreamId = copilotRows.find(row => row.userId === 2)?.id;
    const userOneUpstreamId = copilotRows.find(row => row.userId === 1)?.id;
    assert(userTwoUpstreamId);
    assert(userOneUpstreamId);

    assertEquals(sqlJsRows<{ hour: string; upstream: string | null }>(db, 'SELECT hour, upstream FROM usage ORDER BY hour'), [
      { hour: '2026-05-21T00', upstream: 'up_custom_existing' },
      { hour: '2026-05-21T01', upstream: userTwoUpstreamId },
      { hour: '2026-05-21T02', upstream: null },
      { hour: '2026-05-21T03', upstream: null },
      { hour: '2026-05-21T04', upstream: null },
    ]);
    assertEquals(sqlJsRows<{ requests: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }>(
      db,
      `SELECT
        requests,
        input_tokens AS inputTokens,
        output_tokens AS outputTokens,
        cache_read_tokens AS cacheReadTokens,
        cache_creation_tokens AS cacheCreationTokens
       FROM usage
       WHERE hour = '2026-05-21T04'`,
    ), [
      { requests: 5, inputTokens: 60, outputTokens: 80, cacheReadTokens: 10, cacheCreationTokens: 12 },
    ]);
    assertEquals(sqlJsRows<{ hour: string; upstream: string | null; requests: number; errors: number; totalMsSum: number }>(
      db,
      `SELECT
        hour,
        upstream,
        requests,
        errors,
        total_ms_sum AS totalMsSum
       FROM performance_summary
       ORDER BY hour`,
    ), [
      { hour: '2026-05-21T00', upstream: userOneUpstreamId, requests: 1, errors: 0, totalMsSum: 100 },
      { hour: '2026-05-21T02', upstream: null, requests: 5, errors: 3, totalMsSum: 500 },
    ]);
    assertEquals(sqlJsRows<{ hour: string; upstream: string | null; count: number }>(db, 'SELECT hour, upstream, count FROM performance_latency_buckets ORDER BY hour'), [
      { hour: '2026-05-21T00', upstream: 'up_custom_existing', count: 1 },
      { hour: '2026-05-21T01', upstream: null, count: 3 },
    ]);
    assertEquals(sqlJsRows<{ key: string }>(db, 'SELECT key FROM config ORDER BY key'), [{ key: 'keep_me' }]);
    assertEquals(sqlJsRows<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('github_accounts', 'upstream_configs') ORDER BY name"), []);
  } finally {
    db.close();
  }
});

test('migration 0042 renames bearerToken to apiKey and backfills authStyle on legacy rows', async () => {
  const db = await createMigratedSqlJsDatabase();
  try {
    for (const filename of [...migrationSqlByFilename.keys()].filter(f => f >= '0010_unified_upstreams.sql' && f < '0042_custom_apikey_rename.sql').toSorted()) {
      applySqlJsFile(db, filename);
    }

    // Seed two custom rows mirroring real legacy shapes:
    //   - up_legacy:     post-0010 row with bearerToken and no authStyle
    //   - up_anthropic:  later row with bearerToken AND authStyle: 'anthropic'
    // and a non-custom (azure) row that the migration must leave untouched.
    db.run(`INSERT INTO upstreams (id, provider, name, enabled, sort_order, created_at, updated_at, config_json, flag_overrides, disabled_public_model_ids, proxy_fallback_list_json)
            VALUES
              ('up_legacy', 'custom', 'Legacy', 1, 0, '2026-05-21T00:00:00.000Z', '2026-05-21T00:00:00.000Z', json_object('baseUrl', 'https://a.example/v1', 'bearerToken', 'sk-legacy'), '[]', '[]', '[]'),
              ('up_anthropic', 'custom', 'Anthropic', 1, 1, '2026-05-21T00:00:00.000Z', '2026-05-21T00:00:00.000Z', json_object('baseUrl', 'https://b.example/v1', 'bearerToken', 'sk-ant', 'authStyle', 'anthropic'), '[]', '[]', '[]'),
              ('up_azure', 'azure', 'Azure', 1, 2, '2026-05-21T00:00:00.000Z', '2026-05-21T00:00:00.000Z', json_object('endpoint', 'https://az.example', 'apiKey', 'az-key'), '[]', '[]', '[]')`);

    applySqlJsFile(db, '0042_custom_apikey_rename.sql');

    const rows = sqlJsRows<{ id: string; bearerToken: unknown; apiKey: string; authStyle: string }>(
      db,
      `SELECT
        id,
        json_extract(config_json, '$.bearerToken') AS bearerToken,
        json_extract(config_json, '$.apiKey') AS apiKey,
        json_extract(config_json, '$.authStyle') AS authStyle
       FROM upstreams
       ORDER BY id`,
    );

    assertEquals(rows.find(r => r.id === 'up_legacy'), { id: 'up_legacy', bearerToken: null, apiKey: 'sk-legacy', authStyle: 'bearer' });
    assertEquals(rows.find(r => r.id === 'up_anthropic'), { id: 'up_anthropic', bearerToken: null, apiKey: 'sk-ant', authStyle: 'anthropic' });
    // Non-custom rows are untouched.
    const azure = rows.find(r => r.id === 'up_azure');
    assertEquals(azure?.bearerToken, null);
    assertEquals(azure?.apiKey, 'az-key');
    assertEquals(azure?.authStyle, null);
  } finally {
    db.close();
  }
});

test('migration 0044 rewrites pathOverrides keys to the OpenAI-canonical /path/fragment form', async () => {
  const db = await createMigratedSqlJsDatabase();
  try {
    for (const filename of [...migrationSqlByFilename.keys()].filter(f => f >= '0010_unified_upstreams.sql' && f < '0044_custom_pathoverrides_slash_keys.sql').toSorted()) {
      applySqlJsFile(db, filename);
    }

    // Seed three rows: a custom upstream carrying every legacy underscore key,
    // a custom upstream with no pathOverrides at all (must stay untouched),
    // and a non-custom row that the migration must skip.
    db.run(`INSERT INTO upstreams (id, provider, name, enabled, sort_order, created_at, updated_at, config_json, flag_overrides, disabled_public_model_ids, proxy_fallback_list_json)
            VALUES
              ('up_overrides', 'custom', 'With Overrides', 1, 0, '2026-05-21T00:00:00.000Z', '2026-05-21T00:00:00.000Z',
                json_object('baseUrl', 'https://a.example', 'authStyle', 'bearer', 'apiKey', 'sk-a',
                  'pathOverrides', json_object(
                    'completions', '/p/completions',
                    'chat_completions', '/p/chat/completions',
                    'responses', '/p/responses',
                    'messages', '/p/messages',
                    'embeddings', '/p/embeddings',
                    'images_generations', '/p/images/generations',
                    'images_edits', '/p/images/edits'
                  )
                ), '[]', '[]', '[]'),
              ('up_blank', 'custom', 'No Overrides', 1, 1, '2026-05-21T00:00:00.000Z', '2026-05-21T00:00:00.000Z',
                json_object('baseUrl', 'https://b.example', 'authStyle', 'bearer', 'apiKey', 'sk-b'),
                '[]', '[]', '[]'),
              ('up_azure', 'azure', 'Azure', 1, 2, '2026-05-21T00:00:00.000Z', '2026-05-21T00:00:00.000Z',
                json_object('endpoint', 'https://az.example', 'apiKey', 'az-key',
                  'pathOverrides', json_object('chat_completions', '/should/stay')
                ), '[]', '[]', '[]')`);

    applySqlJsFile(db, '0044_custom_pathoverrides_slash_keys.sql');

    const overrides = sqlJsRows<{ overrides: string }>(
      db,
      `SELECT json_extract(config_json, '$.pathOverrides') AS overrides FROM upstreams WHERE id = 'up_overrides'`,
    );
    assertEquals(JSON.parse(overrides[0].overrides), {
      '/completions': '/p/completions',
      '/chat/completions': '/p/chat/completions',
      '/responses': '/p/responses',
      '/messages': '/p/messages',
      '/embeddings': '/p/embeddings',
      '/images/generations': '/p/images/generations',
      '/images/edits': '/p/images/edits',
    });

    // A row without pathOverrides is left alone — the field stays absent
    // rather than getting an empty `{}` shell.
    const blank = sqlJsRows<{ overrides: unknown }>(
      db,
      `SELECT json_extract(config_json, '$.pathOverrides') AS overrides FROM upstreams WHERE id = 'up_blank'`,
    );
    assertEquals(blank[0].overrides, null);

    // Non-custom rows are out of scope; an azure row's stale snake_case key
    // is intentionally preserved (no other migration touches it).
    const azure = sqlJsRows<{ overrides: string }>(
      db,
      `SELECT json_extract(config_json, '$.pathOverrides') AS overrides FROM upstreams WHERE id = 'up_azure'`,
    );
    assertEquals(JSON.parse(azure[0].overrides), { chat_completions: '/should/stay' });
  } finally {
    db.close();
  }
});

test('migration 0047 backfills openaiDeviceId on legacy Codex rows and leaves populated rows alone', async () => {
  const db = await createMigratedSqlJsDatabase();
  try {
    for (const filename of [...migrationSqlByFilename.keys()].filter(f => f >= '0010_unified_upstreams.sql' && f < '0047_codex_account_openai_device_id.sql').toSorted()) {
      applySqlJsFile(db, filename);
    }

    // Seed three rows:
    //   - up_codex_legacy: codex with no openaiDeviceId — migration must mint
    //   - up_codex_imported: codex with a pre-existing id — migration leaves it
    //   - up_custom: non-codex — migration ignores
    db.run(`INSERT INTO upstreams (id, provider, name, enabled, sort_order, created_at, updated_at, config_json, state_json, flag_overrides, disabled_public_model_ids, proxy_fallback_list_json)
            VALUES
              ('up_codex_legacy', 'codex', 'Codex Legacy', 1, 0, '2026-05-21T00:00:00.000Z', '2026-05-21T00:00:00.000Z',
                json_object('accounts', json_array(json_object('email', 'a@b.com', 'chatgptAccountId', 'acc-legacy', 'chatgptUserId', 'usr', 'planType', 'plus'))),
                json_object('accounts', json_array(json_object('chatgptAccountId', 'acc-legacy', 'refresh_token', 'rt', 'state', 'active', 'state_updated_at', '2026-05-21T00:00:00.000Z'))),
                '[]', '[]', '[]'),
              ('up_codex_imported', 'codex', 'Codex Imported', 1, 1, '2026-05-22T00:00:00.000Z', '2026-05-22T00:00:00.000Z',
                json_object('accounts', json_array(json_object('email', 'a@b.com', 'chatgptAccountId', 'acc-imported', 'chatgptUserId', 'usr', 'planType', 'plus'))),
                json_object('accounts', json_array(json_object('chatgptAccountId', 'acc-imported', 'refresh_token', 'rt', 'state', 'active', 'state_updated_at', '2026-05-22T00:00:00.000Z', 'openaiDeviceId', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'))),
                '[]', '[]', '[]'),
              ('up_custom', 'custom', 'Custom', 1, 2, '2026-05-21T00:00:00.000Z', '2026-05-21T00:00:00.000Z',
                json_object('baseUrl', 'https://a.example/v1', 'apiKey', 'k', 'authStyle', 'bearer'),
                NULL,
                '[]', '[]', '[]')`);

    applySqlJsFile(db, '0047_codex_account_openai_device_id.sql');

    const rows = sqlJsRows<{ id: string; deviceId: string | null }>(
      db,
      `SELECT id, json_extract(state_json, '$.accounts[0].openaiDeviceId') AS deviceId
       FROM upstreams ORDER BY id`,
    );

    const legacy = rows.find(r => r.id === 'up_codex_legacy');
    assert(typeof legacy?.deviceId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(legacy.deviceId), `expected UUIDv4 device id for up_codex_legacy, got ${legacy?.deviceId}`);
    assertEquals(rows.find(r => r.id === 'up_codex_imported')?.deviceId, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    // Non-codex rows have no state_json; the json_extract returns null.
    assertEquals(rows.find(r => r.id === 'up_custom')?.deviceId, null);
  } finally {
    db.close();
  }
});

test('migration 0048 rebuckets Codex quota snapshots by active limit', async () => {
  const db = await createMigratedSqlJsDatabase();
  try {
    for (const filename of [...migrationSqlByFilename.keys()].filter(f => f >= '0010_unified_upstreams.sql' && f < '0048_codex_quota_snapshot_active_limit_map.sql').toSorted()) {
      applySqlJsFile(db, filename);
    }

    db.run(`INSERT INTO upstreams (id, provider, name, enabled, sort_order, created_at, updated_at, config_json, state_json, flag_overrides, disabled_public_model_ids, proxy_fallback_list_json)
            VALUES
              ('up_codex_premium', 'codex', 'Codex Premium', 1, 0, '2026-06-05T00:00:00.000Z', '2026-06-05T00:00:00.000Z',
                json_object('accounts', json_array(json_object('email', 'a@b.com', 'chatgptAccountId', 'acc-premium', 'chatgptUserId', 'usr', 'planType', 'plus'))),
                json_object('accounts', json_array(json_object(
                  'accessToken', NULL,
                  'chatgptAccountId', 'acc-premium',
                  'openaiDeviceId', '11111111-2222-4333-8444-555555555555',
                  'quotaSnapshot', json_extract(json_object(
                    'premium', json_object(
                      'data', json_object('active_limit', 'premium', 'observed_at', '2026-06-05T00:00:00.000Z', 'primary_used_percent', 42),
                      'fetchedAt', 1700000000000
                    )
                  ), '$.premium'),
                  'refresh_token', 'rt',
                  'state', 'active',
                  'state_updated_at', '2026-06-05T00:00:00.000Z'
                ))),
                '[]', '[]', '[]'),
              ('up_codex_missing_limit', 'codex', 'Codex Missing Limit', 1, 1, '2026-06-05T00:00:00.000Z', '2026-06-05T00:00:00.000Z',
                json_object('accounts', json_array(json_object('email', 'a@b.com', 'chatgptAccountId', 'acc-missing', 'chatgptUserId', 'usr', 'planType', 'plus'))),
                json_object('accounts', json_array(json_object(
                  'accessToken', NULL,
                  'chatgptAccountId', 'acc-missing',
                  'openaiDeviceId', '22222222-3333-4444-8555-666666666666',
                  'quotaSnapshot', json_extract(json_object(
                    'unknown', json_object(
                      'data', json_object('observed_at', '2026-06-05T01:00:00.000Z'),
                      'fetchedAt', 1700000001000
                    )
                  ), '$.unknown'),
                  'refresh_token', 'rt',
                  'state', 'active',
                  'state_updated_at', '2026-06-05T00:00:00.000Z'
                ))),
                '[]', '[]', '[]'),
              ('up_codex_unsafe_limit', 'codex', 'Codex Unsafe Limit', 1, 2, '2026-06-05T00:00:00.000Z', '2026-06-05T00:00:00.000Z',
                json_object('accounts', json_array(json_object('email', 'a@b.com', 'chatgptAccountId', 'acc-unsafe', 'chatgptUserId', 'usr', 'planType', 'plus'))),
                json_object('accounts', json_array(json_object(
                  'accessToken', NULL,
                  'chatgptAccountId', 'acc-unsafe',
                  'openaiDeviceId', '33333333-4444-4555-8666-777777777777',
                  'quotaSnapshot', json_extract(json_object(
                    'unknown', json_object(
                      'data', json_object('active_limit', 'constructor', 'observed_at', '2026-06-05T02:00:00.000Z'),
                      'fetchedAt', 1700000002000
                    )
                  ), '$.unknown'),
                  'refresh_token', 'rt',
                  'state', 'active',
                  'state_updated_at', '2026-06-05T00:00:00.000Z'
                ))),
                '[]', '[]', '[]'),
              ('up_codex_map', 'codex', 'Codex Map', 1, 3, '2026-06-05T00:00:00.000Z', '2026-06-05T00:00:00.000Z',
                json_object('accounts', json_array(json_object('email', 'a@b.com', 'chatgptAccountId', 'acc-map', 'chatgptUserId', 'usr', 'planType', 'plus'))),
                json_object('accounts', json_array(json_object(
                  'accessToken', NULL,
                  'chatgptAccountId', 'acc-map',
                  'openaiDeviceId', '44444444-5555-4666-8777-888888888888',
                  'quotaSnapshot', json_object(
                    'premium', json_object('data', json_object('active_limit', 'premium', 'observed_at', '2026-06-05T03:00:00.000Z'), 'fetchedAt', 1700000003000)
                  ),
                  'refresh_token', 'rt',
                  'state', 'active',
                  'state_updated_at', '2026-06-05T00:00:00.000Z'
                ))),
                '[]', '[]', '[]'),
              ('up_custom', 'custom', 'Custom', 1, 4, '2026-06-05T00:00:00.000Z', '2026-06-05T00:00:00.000Z',
                json_object('baseUrl', 'https://a.example/v1', 'apiKey', 'k', 'authStyle', 'bearer'),
                json_object('accounts', json_array(json_object('quotaSnapshot', json_object('premium', json_object('data', json_object('active_limit', 'premium'), 'fetchedAt', 1))))),
                '[]', '[]', '[]')`);

    applySqlJsFile(db, '0048_codex_quota_snapshot_active_limit_map.sql');

    const rows = sqlJsRows<{ id: string; stateJson: string; snapshot: string }>(
      db,
      `SELECT
        id,
        state_json AS stateJson,
        json_extract(state_json, '$.accounts[0].quotaSnapshot') AS snapshot
       FROM upstreams
       ORDER BY id`,
    );
    const snapshotFor = (id: string): unknown => JSON.parse(rows.find(r => r.id === id)!.snapshot);

    assertEquals(snapshotFor('up_codex_premium'), {
      premium: {
        data: { active_limit: 'premium', observed_at: '2026-06-05T00:00:00.000Z', primary_used_percent: 42 },
        fetchedAt: 1700000000000,
      },
    });
    assertEquals(rows.find(r => r.id === 'up_codex_premium')!.stateJson, JSON.stringify({
      accounts: [{
        accessToken: null,
        chatgptAccountId: 'acc-premium',
        openaiDeviceId: '11111111-2222-4333-8444-555555555555',
        quotaSnapshot: {
          premium: {
            data: { active_limit: 'premium', observed_at: '2026-06-05T00:00:00.000Z', primary_used_percent: 42 },
            fetchedAt: 1700000000000,
          },
        },
        refresh_token: 'rt',
        state: 'active',
        state_updated_at: '2026-06-05T00:00:00.000Z',
      }],
    }));
    assertEquals(snapshotFor('up_codex_missing_limit'), {
      unknown: { data: { observed_at: '2026-06-05T01:00:00.000Z' }, fetchedAt: 1700000001000 },
    });
    assertEquals(snapshotFor('up_codex_unsafe_limit'), {
      unknown: { data: { active_limit: 'constructor', observed_at: '2026-06-05T02:00:00.000Z' }, fetchedAt: 1700000002000 },
    });
    assertEquals(snapshotFor('up_codex_map'), {
      premium: { data: { active_limit: 'premium', observed_at: '2026-06-05T03:00:00.000Z' }, fetchedAt: 1700000003000 },
    });
    assertEquals(snapshotFor('up_custom'), {
      premium: { data: { active_limit: 'premium' }, fetchedAt: 1 },
    });
  } finally {
    db.close();
  }
});

test('migration 0055 names existing direct fallback entries direct_fetch', async () => {
  const db = await createMigratedSqlJsDatabase();
  try {
    for (const filename of [...migrationSqlByFilename.keys()].filter(f => f >= '0010_unified_upstreams.sql' && f < '0055_direct_transport_fallbacks.sql').toSorted()) {
      applySqlJsFile(db, filename);
    }

    db.run(`INSERT INTO upstreams (id, provider, name, enabled, sort_order, created_at, updated_at, config_json, flag_overrides, disabled_public_model_ids, proxy_fallback_list_json)
            VALUES
              ('up_direct', 'custom', 'Direct', 1, 0, '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z',
                json_object('baseUrl', 'https://a.example', 'apiKey', 'k', 'authStyle', 'bearer'),
                '[]', '[]', '[{"id":"p_first"},{"id":"direct","colos":["SIN"]},{"id":"p_last"}]'),
              ('up_proxy_only', 'custom', 'Proxy only', 1, 1, '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z',
                json_object('baseUrl', 'https://b.example', 'apiKey', 'k', 'authStyle', 'bearer'),
                '[]', '[]', '[{"id":"p_only"}]'),
              ('up_empty', 'custom', 'Empty', 1, 2, '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z',
                json_object('baseUrl', 'https://c.example', 'apiKey', 'k', 'authStyle', 'bearer'),
                '[]', '[]', '[]')`);

    applySqlJsFile(db, '0055_direct_transport_fallbacks.sql');

    const rows = sqlJsRows<{ id: string; fallback: string }>(
      db,
      'SELECT id, proxy_fallback_list_json AS fallback FROM upstreams ORDER BY id',
    );
    assertEquals(JSON.parse(rows.find(row => row.id === 'up_direct')!.fallback), [
      { id: 'p_first' },
      { id: 'direct_fetch', colos: ['SIN'] },
      { id: 'p_last' },
    ]);
    assertEquals(JSON.parse(rows.find(row => row.id === 'up_proxy_only')!.fallback), [{ id: 'p_only' }]);
    assertEquals(JSON.parse(rows.find(row => row.id === 'up_empty')!.fallback), []);
  } finally {
    db.close();
  }
});

type FakeUpstreamRow = {
  id: string;
  provider: string;
  name: string;
  enabled: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
  config_json: string;
  state_json: string | null;
  flag_overrides: string;
  disabled_public_model_ids: string;
  proxy_fallback_list_json: string;
  model_prefix_json: string | null;
  color: string | null;
};

class FakeUpstreamsSqlPreparedStatement {
  private binds: unknown[] = [];

  constructor(private db: FakeUpstreamsSqlDatabase, private query: string) {}

  bind(...values: unknown[]): FakeUpstreamsSqlPreparedStatement {
    this.binds = values;
    return this;
  }

  first<T>(): Promise<T | null> {
    if (this.query.includes('FROM upstreams WHERE id = ?')) {
      return Promise.resolve((this.db.selectById(this.binds[0] as string) as T | undefined) ?? null);
    }

    throw new Error(`Unsupported first() query in upstreams test: ${this.query}`);
  }

  all<T>(): Promise<{ results: T[]; success: true; meta: Record<string, unknown> }> {
    if (this.query.includes('FROM upstreams')) {
      return Promise.resolve({
        results: this.db.selectAll() as T[],
        success: true,
        meta: {},
      });
    }

    throw new Error(`Unsupported all() query in upstreams test: ${this.query}`);
  }

  run(): Promise<{ results: never[]; success: true; meta: Record<string, unknown> }> {
    if (this.query.startsWith('INSERT INTO upstreams')) {
      this.db.upsert(this.binds);
      return Promise.resolve({ results: [], success: true, meta: { changes: 1 } });
    }
    if (this.query === 'DELETE FROM upstreams') {
      this.db.rows = [];
      return Promise.resolve({ results: [], success: true, meta: { changes: 0 } });
    }
    if (this.query.startsWith('DELETE FROM upstreams WHERE id = ?')) {
      const deleted = this.db.deleteById(this.binds[0] as string);
      return Promise.resolve({ results: [], success: true, meta: { changes: deleted ? 1 : 0 } });
    }

    throw new Error(`Unsupported run() query in upstreams test: ${this.query}`);
  }
}

class FakeUpstreamsSqlDatabase implements SqlDatabase {
  exec(): Promise<unknown> { return Promise.resolve(undefined); }

  rows: FakeUpstreamRow[] = [];

  prepare(query: string): FakeUpstreamsSqlPreparedStatement {
    return new FakeUpstreamsSqlPreparedStatement(this, query);
  }

  selectAll(): FakeUpstreamRow[] {
    return this.rows.map(cloneFakeUpstreamRow).toSorted(compareFakeUpstreamRows);
  }

  selectById(id: string): FakeUpstreamRow | undefined {
    const row = this.rows.find(candidate => candidate.id === id);
    return row ? cloneFakeUpstreamRow(row) : undefined;
  }

  upsert(binds: unknown[]): void {
    const [id, provider, name, enabled, sortOrder, createdAt, updatedAt, configJson, stateJson, flagOverrides, disabledPublicModelIds, proxyFallbackListJson, modelPrefixJson, color] = binds as [string, string, string, number, number, string, string, string, string | null, string, string, string, string | null, string | null];
    const existingIndex = this.rows.findIndex(candidate => candidate.id === id);
    const preservedCreatedAt = existingIndex >= 0 ? this.rows[existingIndex].created_at : createdAt;
    const row = {
      id,
      provider,
      name,
      enabled,
      sort_order: sortOrder,
      created_at: preservedCreatedAt,
      updated_at: updatedAt,
      config_json: configJson,
      state_json: stateJson,
      flag_overrides: flagOverrides,
      disabled_public_model_ids: disabledPublicModelIds,
      proxy_fallback_list_json: proxyFallbackListJson,
      model_prefix_json: modelPrefixJson,
      color,
    };
    if (existingIndex >= 0) {
      this.rows[existingIndex] = row;
      return;
    }
    this.rows.push(row);
  }

  deleteById(id: string): boolean {
    const previousLength = this.rows.length;
    this.rows = this.rows.filter(row => row.id !== id);
    return this.rows.length !== previousLength;
  }
}

const cloneFakeUpstreamRow = (row: FakeUpstreamRow): FakeUpstreamRow => ({ ...row });

const compareFakeUpstreamRows = (a: FakeUpstreamRow, b: FakeUpstreamRow): number => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at);

type SqlJsDatabase = {
  run(sql: string): void;
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>;
  close(): void;
};

const migrationSqlByPath = import.meta.glob('../../migrations/*.sql', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

const migrationSqlByFilename = new Map(
  Object.entries(migrationSqlByPath).map(([path, sql]) => [path.slice(path.lastIndexOf('/') + 1), sql]),
);

const createMigratedSqlJsDatabase = async (): Promise<SqlJsDatabase> => {
  const SQL = await initSqlJs();
  const db = new SQL.Database() as SqlJsDatabase;
  for (const filename of [...migrationSqlByFilename.keys()].filter(filename => filename < '0010_unified_upstreams.sql').toSorted()) {
    applySqlJsFile(db, filename);
  }
  return db;
};

const applySqlJsFile = (db: SqlJsDatabase, filename: string): void => {
  const sql = migrationSqlByFilename.get(filename);
  if (!sql) throw new Error(`Missing migration SQL fixture: ${filename}`);
  db.run(sql);
};

const sqlJsRows = <T>(db: SqlJsDatabase, sql: string): T[] => {
  const [result] = db.exec(sql);
  if (!result) return [];
  return result.values.map(values => Object.fromEntries(result.columns.map((column, index) => [column, values[index] ?? null])) as T);
};

const seedLegacyUpstreamData = (db: SqlJsDatabase): void => {
  db.run(
    `INSERT INTO github_accounts (user_id, token, login, name, avatar_url, account_type)
     VALUES
       (1, 'gho_one', 'one', 'One User', 'https://avatars.example/one.png', 'individual'),
       (2, 'gho_two', 'two', NULL, 'https://avatars.example/two.png', 'business');

     INSERT INTO config (key, value)
     VALUES
       ('github_account_order', '[999,2]'),
       ('models_cache_v2:stale', 'stale'),
       ('keep_me', 'ok');

     INSERT INTO upstream_configs (id, name, base_url, bearer_token, supported_endpoints, enabled, sort_order, created_at, enabled_fixes, path_overrides)
     VALUES (
       'up_custom_existing',
       'Existing Custom',
       'https://custom.example/v1',
       'sk-custom',
       '["/chat/completions"]',
       1,
       0,
       '2026-05-21T00:00:00.000Z',
       '["z-fix","a-fix"]',
       '{"chat_completions":"/chat/completions"}'
     );

     INSERT INTO usage (key_id, model, upstream, model_key, hour, requests, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens)
     VALUES
       ('key', 'gpt-5.4', 'openai:up_custom_existing', 'gpt-5.4', '2026-05-21T00', 1, 2, 3, 0, 0),
       ('key', 'gpt-5.4', 'copilot:2', 'gpt-5.4', '2026-05-21T01', 1, 2, 3, 0, 0),
       ('key', 'gpt-5.4', NULL, 'gpt-5.4', '2026-05-21T02', 1, 2, 3, 0, 0),
       ('key', 'gpt-5.4', 'copilot:999', 'gpt-5.4', '2026-05-21T03', 1, 2, 3, 0, 0),
       ('key', 'gpt-5.4', 'copilot:998', 'gpt-5.4', '2026-05-21T04', 2, 20, 30, 4, 5),
       ('key', 'gpt-5.4', 'copilot:999', 'gpt-5.4', '2026-05-21T04', 3, 40, 50, 6, 7);

     INSERT INTO performance_summary (hour, metric_scope, key_id, model, upstream, model_key, source_api, target_api, stream, runtime_location, requests, errors, total_ms_sum)
     VALUES
       ('2026-05-21T00', 'request_total', 'key', 'gpt-5.4', 'copilot:1', 'gpt-5.4', 'messages', 'responses', 1, 'unknown', 1, 0, 100),
       ('2026-05-21T02', 'request_total', 'key', 'gpt-5.4', 'copilot:998', 'gpt-5.4', 'messages', 'responses', 1, 'unknown', 2, 1, 200),
       ('2026-05-21T02', 'request_total', 'key', 'gpt-5.4', 'copilot:999', 'gpt-5.4', 'messages', 'responses', 1, 'unknown', 3, 2, 300);

     INSERT INTO performance_latency_buckets (hour, metric_scope, key_id, model, upstream, model_key, source_api, target_api, stream, runtime_location, lower_ms, upper_ms, count)
     VALUES
       ('2026-05-21T00', 'request_total', 'key', 'gpt-5.4', 'openai:up_custom_existing', 'gpt-5.4', 'messages', 'responses', 1, 'unknown', 0, 142, 1),
       ('2026-05-21T01', 'request_total', 'key', 'gpt-5.4', 'copilot:998', 'gpt-5.4', 'messages', 'responses', 1, 'unknown', 0, 142, 2),
       ('2026-05-21T01', 'request_total', 'key', 'gpt-5.4', 'copilot:999', 'gpt-5.4', 'messages', 'responses', 1, 'unknown', 0, 142, 1);`,
  );
};
