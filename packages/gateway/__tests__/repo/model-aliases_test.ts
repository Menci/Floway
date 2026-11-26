// Cross-backend tests for the model aliases repo. Memory drives the unit
// scenarios by default; the SQL backend (sql.js applying every migration)
// catches schema drift, JSON-column round-trips, and name uniqueness.

import { test } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { createSqliteTestDb, createSqlJsDatabase, migrationSqlByFilename, type SqlJsDatabase } from './test-sqlite.ts';
import { SqlRepo } from '../../src/repo/sql.ts';
import type { ModelAliasRecord, Repo } from '../../src/repo/types.ts';
import { assertEquals, assertExists, assertRejects, assertThrows } from '@floway-dev/test-utils';

const REPO_BACKENDS: Array<readonly [string, () => Promise<Repo>]> = [
  ['memory', async () => new InMemoryRepo()],
  ['sql', async () => new SqlRepo(await createSqliteTestDb())],
];

// The fixture derives its id from the name so a test that inserts several
// rows gets distinct primary keys without restating both fields.
const aliasFixture = (overrides: Partial<ModelAliasRecord> = {}): ModelAliasRecord => ({
  id: `alias_${overrides.name ?? 'gpt-fast'}`,
  name: 'gpt-fast',
  kind: 'chat',
  selection: 'first-available',
  displayName: null,
  visibleInModelsList: true,
  targets: [
    { target_model_id: 'gpt-5.4', rules: { reasoning: { effort: 'low' } } },
  ],
  announcedMetadata: null,
  sortOrder: 0,
  createdAt: '2026-06-26T00:00:00.000Z',
  updatedAt: '2026-06-26T00:00:00.000Z',
  ...overrides,
});

for (const [backend, makeRepo] of REPO_BACKENDS) {
  // Every test starts from a known-empty state so assertions on row counts and
  // ordering stay stable.
  const freshRepo = async (): Promise<Repo> => {
    const repo = await makeRepo();
    await repo.modelAliases.deleteAll();
    return repo;
  };

  test(`[${backend}] insert with a name another row already holds throws`, async () => {
    const repo = await freshRepo();
    await repo.modelAliases.insert(aliasFixture());
    await assertRejects(() => repo.modelAliases.insert(aliasFixture({ id: 'alias_second' })));
  });

  test(`[${backend}] rename keeps the row under its original id`, async () => {
    const repo = await freshRepo();
    await repo.modelAliases.insert(aliasFixture({ createdAt: '2026-01-01T00:00:00.000Z' }));
    await repo.modelAliases.update(aliasFixture({
      id: 'alias_gpt-fast',
      name: 'gpt-fastest',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-06-26T12:00:00.000Z',
    }));
    assertEquals(await repo.modelAliases.getByName('gpt-fast'), null);
    const renamed = await repo.modelAliases.getById('alias_gpt-fast');
    assertExists(renamed);
    assertEquals(renamed.name, 'gpt-fastest');
    assertEquals(renamed.createdAt, '2026-01-01T00:00:00.000Z');
  });

}

test('[sql] preserves passthrough alias metadata fields owned by a future schema', async () => {
  const db = await createSqliteTestDb();
  await db.prepare(
    `INSERT INTO model_aliases (id, name, kind, selection, visible_in_models_list, targets, announced_metadata_json, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    'alias_passthrough',
    'passthrough',
    'chat',
    'first-available',
    1,
    '[{"target_model_id":"model-a","rules":{"verbosity":"high","futureRule":{"__proto__":{"marker":"rule"}}},"futureTarget":"kept"}]',
    '{"limits":{"max_output_tokens":1024,"futureLimit":7},"futureMetadata":{"__proto__":{"marker":"metadata"}}}',
    1,
    '2026-07-21T00:00:00.000Z',
    '2026-07-21T00:00:00.000Z',
  ).run();

  const row = await new SqlRepo(db).modelAliases.getById('alias_passthrough');
  assertEquals(row?.targets, [{
    target_model_id: 'model-a',
    rules: { verbosity: 'high', futureRule: JSON.parse('{"__proto__":{"marker":"rule"}}') },
    futureTarget: 'kept',
  }]);
  assertEquals(row?.announcedMetadata, {
    limits: { max_output_tokens: 1024, futureLimit: 7 },
    futureMetadata: JSON.parse('{"__proto__":{"marker":"metadata"}}'),
  });
  const futureRule = row === null ? null : Reflect.get(row.targets[0].rules, 'futureRule');
  const futureMetadata = row?.announcedMetadata === null || row?.announcedMetadata === undefined
    ? null
    : Reflect.get(row.announcedMetadata, 'futureMetadata');
  assertEquals(futureRule !== null && typeof futureRule === 'object' && Object.hasOwn(futureRule, '__proto__'), true);
  assertEquals(futureMetadata !== null && typeof futureMetadata === 'object' && Object.hasOwn(futureMetadata, '__proto__'), true);
});

const migrationFilenames = migrationSqlByFilename.map(([filename]) => filename);

const createPreUpstreamsMigrationDatabase = async (): Promise<SqlJsDatabase> => {
  const db = await createSqlJsDatabase();
  for (const filename of migrationFilenames.filter(filename => filename < '0010_unified_upstreams.sql')) {
    applyMigration(db, filename);
  }
  return db;
};

const applyMigration = (db: SqlJsDatabase, filename: string): void => {
  const sql = migrationSqlByFilename.find(([candidate]) => candidate === filename)?.[1];
  if (sql === undefined) throw new Error(`Missing migration SQL fixture: ${filename}`);
  db.run(sql);
};

const sqlRows = <T>(db: SqlJsDatabase, sql: string): T[] => {
  const [result] = db.exec(sql);
  if (!result) return [];
  return result.values.map(values => Object.fromEntries(result.columns.map((column, index) => [column, values[index] ?? null])) as T);
};

test('migration 0071 issues an id per existing alias and keeps names unique', async () => {
  const db = await createPreUpstreamsMigrationDatabase();
  try {
    for (const filename of migrationFilenames.filter(filename => filename >= '0010_unified_upstreams.sql' && filename < '0071_model_alias_id.sql').toSorted()) {
      applyMigration(db, filename);
    }

    db.run(`INSERT INTO model_aliases (name, kind, selection, visible_in_models_list, targets, sort_order, created_at, updated_at)
            VALUES ('vendor/model', 'chat', 'first-available', 1, '[]', 1, '2026-07-21T00:00:00.000Z', '2026-07-21T00:00:00.000Z')`);

    applyMigration(db, '0071_model_alias_id.sql');

    const rows = sqlRows<{ id: string; name: string }>(db, 'SELECT id, name FROM model_aliases ORDER BY sort_order, created_at');
    assertEquals(rows.map(row => row.name), ['vendor/model']);
    assertEquals(rows.every(row => /^alias_[0-9a-f]{24}$/.test(row.id)), true);
    assertEquals(new Set(rows.map(row => row.id)).size, rows.length);

    assertThrows(
      () => db.run(`INSERT INTO model_aliases (id, name, kind, selection, visible_in_models_list, targets, sort_order, created_at, updated_at)
                    VALUES ('alias_duplicate', 'vendor/model', 'chat', 'first-available', 1, '[]', 2, '2026-07-21T00:00:00.000Z', '2026-07-21T00:00:00.000Z')`),
      Error,
    );
  } finally {
    db.close();
  }
});
