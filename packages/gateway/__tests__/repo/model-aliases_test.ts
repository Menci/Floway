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
  // The 0046 migration seeds `codex-auto-review`; every test starts from a
  // known-empty state so assertions on row counts and ordering stay stable.
  const freshRepo = async (): Promise<Repo> => {
    const repo = await makeRepo();
    await repo.modelAliases.deleteAll();
    return repo;
  };

  test(`[${backend}] insert then list returns the row`, async () => {
    const repo = await freshRepo();
    await repo.modelAliases.insert(aliasFixture());
    const list = await repo.modelAliases.list();
    assertEquals(list.length, 1);
    assertEquals(list[0].name, 'gpt-fast');
    assertEquals(list[0].targets[0].target_model_id, 'gpt-5.4');
  });

  test(`[${backend}] insert with a name another row already holds throws`, async () => {
    const repo = await freshRepo();
    await repo.modelAliases.insert(aliasFixture());
    await assertRejects(() => repo.modelAliases.insert(aliasFixture({ id: 'alias_second' })));
  });

  test(`[${backend}] getByName returns null when no row matches`, async () => {
    const repo = await freshRepo();
    assertEquals(await repo.modelAliases.getByName('nope'), null);
  });

  test(`[${backend}] getById returns null when no row matches`, async () => {
    const repo = await freshRepo();
    assertEquals(await repo.modelAliases.getById('alias_nope'), null);
  });

  test(`[${backend}] update preserves createdAt and refreshes updatedAt`, async () => {
    const repo = await freshRepo();
    await repo.modelAliases.insert(aliasFixture({ createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }));
    await repo.modelAliases.update(aliasFixture({
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-06-26T12:00:00.000Z',
      displayName: 'GPT Fast',
    }));
    const after = await repo.modelAliases.getByName('gpt-fast');
    assertExists(after);
    assertEquals(after.createdAt, '2026-01-01T00:00:00.000Z');
    assertEquals(after.updatedAt, '2026-06-26T12:00:00.000Z');
    assertEquals(after.displayName, 'GPT Fast');
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

  test(`[${backend}] rename to a name another row holds throws and leaves both rows intact`, async () => {
    const repo = await freshRepo();
    await repo.modelAliases.insert(aliasFixture({ name: 'gpt-fast' }));
    await repo.modelAliases.insert(aliasFixture({ name: 'gpt-slow' }));
    await assertRejects(() => repo.modelAliases.update(aliasFixture({ id: 'alias_gpt-fast', name: 'gpt-slow' })));
    assertExists(await repo.modelAliases.getByName('gpt-fast'));
    assertExists(await repo.modelAliases.getByName('gpt-slow'));
  });

  test(`[${backend}] update on a missing id throws`, async () => {
    const repo = await freshRepo();
    await assertRejects(() => repo.modelAliases.update(aliasFixture({ id: 'alias_nope' })));
  });

  test(`[${backend}] delete returns true when present, false when absent`, async () => {
    const repo = await freshRepo();
    await repo.modelAliases.insert(aliasFixture());
    assertEquals(await repo.modelAliases.delete('alias_gpt-fast'), true);
    assertEquals(await repo.modelAliases.delete('alias_gpt-fast'), false);
  });

  test(`[${backend}] list orders by (sortOrder, createdAt)`, async () => {
    const repo = await freshRepo();
    await repo.modelAliases.insert(aliasFixture({ name: 'a', sortOrder: 1, createdAt: '2026-01-01T00:00:00.000Z' }));
    await repo.modelAliases.insert(aliasFixture({ name: 'b', sortOrder: 0, createdAt: '2026-02-01T00:00:00.000Z' }));
    await repo.modelAliases.insert(aliasFixture({ name: 'c', sortOrder: 0, createdAt: '2026-01-15T00:00:00.000Z' }));
    const list = await repo.modelAliases.list();
    assertEquals(list.map(r => r.name), ['c', 'b', 'a']);
  });

  test(`[${backend}] targets JSON round-trips multi-target chat rules`, async () => {
    const repo = await freshRepo();
    await repo.modelAliases.insert(aliasFixture({
      name: 'multi',
      targets: [
        { target_model_id: 'gpt-5.4', rules: { reasoning: { effort: 'high', adaptive: true } } },
        { target_model_id: 'gpt-4.1', rules: { verbosity: 'low', serviceTier: 'priority' } },
        { target_model_id: 'gpt-3.5', rules: {} },
      ],
    }));
    const row = await repo.modelAliases.getByName('multi');
    assertExists(row);
    assertEquals(row.targets.length, 3);
    assertEquals(row.targets[0].rules, { reasoning: { effort: 'high', adaptive: true } });
    assertEquals(row.targets[1].rules, { verbosity: 'low', serviceTier: 'priority' });
    assertEquals(row.targets[2].rules, {});
  });

  test(`[${backend}] visibleInModelsList=false round-trips`, async () => {
    const repo = await freshRepo();
    await repo.modelAliases.insert(aliasFixture({ visibleInModelsList: false }));
    const row = await repo.modelAliases.getByName('gpt-fast');
    assertEquals(row?.visibleInModelsList, false);
  });

  test(`[${backend}] announcedMetadata round-trips through JSON column`, async () => {
    const repo = await freshRepo();
    await repo.modelAliases.insert(aliasFixture({
      name: 'overridden',
      announcedMetadata: {
        limits: { max_output_tokens: 8192 },
        chat: { modalities: { input: ['text'], output: ['text'] } },
      },
    }));
    const row = await repo.modelAliases.getByName('overridden');
    assertEquals(row?.announcedMetadata, {
      limits: { max_output_tokens: 8192 },
      chat: { modalities: { input: ['text'], output: ['text'] } },
    });
  });

  test(`[${backend}] deleteAll wipes every row`, async () => {
    const repo = await freshRepo();
    await repo.modelAliases.insert(aliasFixture({ name: 'a' }));
    await repo.modelAliases.insert(aliasFixture({ name: 'b' }));
    await repo.modelAliases.deleteAll();
    assertEquals((await repo.modelAliases.list()).length, 0);
  });
}

// Fresh-DB coverage for the seed row applied by migration 0046, run outside
// the freshRepo() cleanup loop so the row survives to be asserted on.
// Memory-backed repos have no migration seeding, so this only covers the SQL
// backend.
test('[sql] migration 0046 seeds the codex-auto-review alias with its two-target list', async () => {
  const repo = new SqlRepo(await createSqliteTestDb());
  const rows = await repo.modelAliases.list();
  const seed = rows.find(row => row.name === 'codex-auto-review');
  assertExists(seed);
  assertEquals(seed.displayName, 'Codex Auto Review');
  assertEquals(seed.visibleInModelsList, true);
  assertEquals(seed.selection, 'first-available');
  assertEquals(seed.kind, 'chat');
  assertEquals(seed.targets, [
    { target_model_id: 'codex-auto-review', rules: {} },
    { target_model_id: 'gpt-5.4', rules: { reasoning: { effort: 'low' } } },
  ]);
});

test('[sql] rejects an unknown kind stored under the open database constraint', async () => {
  const db = await createSqliteTestDb();
  await db.prepare(
    `INSERT INTO model_aliases (id, name, kind, selection, visible_in_models_list, targets, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind('alias_future', 'future-alias', 'future-kind', 'first-available', 1, '[]', 1, '2026-07-21T00:00:00.000Z', '2026-07-21T00:00:00.000Z').run();

  const repo = new SqlRepo(db);
  await assertRejects(() => repo.modelAliases.getByName('future-alias'), Error, 'model_aliases.kind for future-alias is invalid');
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

test('migration 0062 opens model alias kind while preserving existing aliases', async () => {
  const db = await createPreUpstreamsMigrationDatabase();
  try {
    for (const filename of migrationFilenames.filter(filename => filename >= '0010_unified_upstreams.sql' && filename < '0063_model_alias_kind.sql').toSorted()) {
      applyMigration(db, filename);
    }

    applyMigration(db, '0063_model_alias_kind.sql');
    db.run(`INSERT INTO model_aliases (name, kind, selection, visible_in_models_list, targets, sort_order, created_at, updated_at)
            VALUES ('rerank-alias', 'rerank', 'first-available', 1, '[]', 1, '2026-07-21T00:00:00.000Z', '2026-07-21T00:00:00.000Z')`);

    assertEquals(sqlRows<{ name: string; kind: string }>(db, 'SELECT name, kind FROM model_aliases ORDER BY sort_order, created_at'), [
      { name: 'codex-auto-review', kind: 'chat' },
      { name: 'rerank-alias', kind: 'rerank' },
    ]);
    assertThrows(
      () => db.run(`INSERT INTO model_aliases (name, kind, selection, visible_in_models_list, targets, sort_order, created_at, updated_at)
                    VALUES ('empty-kind', '', 'first-available', 1, '[]', 2, '2026-07-21T00:00:00.000Z', '2026-07-21T00:00:00.000Z')`),
      Error,
    );
  } finally {
    db.close();
  }
});

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
    assertEquals(rows.map(row => row.name), ['codex-auto-review', 'vendor/model']);
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
