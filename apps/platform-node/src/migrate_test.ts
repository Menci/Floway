import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { test } from 'vitest';

import { applyMigrations } from './migrate.ts';
import { createNodeSqliteDatabase } from './node-sqlite-database.ts';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

const REAL_MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..', 'packages', 'gateway', 'migrations',
);

const withTemp = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), 'migrate-test-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

test('applies all real migration files against a fresh sqlite', () => withTemp(async dir => {
  const db = createNodeSqliteDatabase(join(dir, 'real.db'));
  await applyMigrations(db);

  // Schema check: a stable table from migration 0001 exists with expected columns.
  const apiKeyCols = await db.prepare('PRAGMA table_info(api_keys)').all<{ name: string }>();
  const colNames = apiKeyCols.results.map(r => r.name).toSorted();
  assertEquals(colNames.includes('id'), true);
  assertEquals(colNames.includes('key'), true);
  assertEquals(colNames.includes('server_secret'), true);

  // Every migration was recorded.
  const recorded = await db.prepare('SELECT COUNT(*) AS n FROM _migrations').first<{ n: number }>();
  assertEquals(recorded !== null && recorded.n > 0, true);
}));

// Migration filenames must start with a unique NNNN_ prefix so that the
// lexical apply order is unambiguous, both here and in `wrangler d1
// migrations apply` (which sorts the same way). A duplicate prefix means two
// branches independently picked the same number — the second one to merge
// must be renumbered before it is applied anywhere.
//
// The two collisions below predate this check and are already applied to
// production D1. Renaming them now would orphan the recorded entry in
// `d1_migrations` and trick wrangler into re-running each file under its new
// name — both DROP/CREATE pairs would error against an already-mutated
// schema. They are grandfathered; every new migration must keep this list
// empty.
const KNOWN_DUPLICATE_PREFIXES: ReadonlySet<string> = new Set(['0011', '0025']);

test('every migration file has a unique numeric prefix', async () => {
  const files = (await readdir(REAL_MIGRATIONS_DIR)).filter(f => f.endsWith('.sql'));
  const byPrefix = new Map<string, string[]>();
  for (const file of files) {
    const match = /^(\d{4})_/.exec(file);
    assertEquals(match !== null, true, `migration filename must start with NNNN_: ${file}`);
    const prefix = match![1];
    const bucket = byPrefix.get(prefix) ?? [];
    bucket.push(file);
    byPrefix.set(prefix, bucket);
  }
  const collisions = [...byPrefix.entries()]
    .filter(([prefix, bucket]) => bucket.length > 1 && !KNOWN_DUPLICATE_PREFIXES.has(prefix))
    .map(([, bucket]) => bucket);
  assertEquals(collisions, [], `duplicate migration numbers: ${JSON.stringify(collisions)}`);
});

test('rerun is a no-op once all migrations are applied', () => withTemp(async dir => {
  const db = createNodeSqliteDatabase(join(dir, 'idempotent.db'));
  await applyMigrations(db);
  const firstCount = await db.prepare('SELECT COUNT(*) AS n FROM _migrations').first<{ n: number }>();

  await applyMigrations(db);
  const secondCount = await db.prepare('SELECT COUNT(*) AS n FROM _migrations').first<{ n: number }>();
  assertEquals(secondCount?.n, firstCount?.n);
}));

test('mid-migration failure rolls back and leaves no partial schema', () => withTemp(async dir => {
  const migrationsDir = join(dir, 'migrations');
  await rm(migrationsDir, { recursive: true, force: true });
  const { mkdir } = await import('node:fs/promises');
  await mkdir(migrationsDir, { recursive: true });

  // First statement creates a table; second is invalid SQL — the transaction
  // must roll back so the table from the first statement does not survive.
  await writeFile(
    join(migrationsDir, '0001_bad.sql'),
    'CREATE TABLE only_in_failed_migration (id INTEGER);\n'
    + 'NOT VALID SQL HERE;\n',
  );

  const db = createNodeSqliteDatabase(join(dir, 'rollback.db'));
  await assertRejects(() => applyMigrations(db, migrationsDir));

  const tables = await db.prepare(
    'SELECT name FROM sqlite_master WHERE type = \'table\' AND name = ?',
  ).bind('only_in_failed_migration').all<{ name: string }>();
  assertEquals(tables.results, []);

  const recorded = await db.prepare('SELECT name FROM _migrations').all<{ name: string }>();
  assertEquals(recorded.results, []);
}));

test('skips already-applied migrations on partial state', () => withTemp(async dir => {
  const migrationsDir = join(dir, 'migrations');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(migrationsDir, { recursive: true });
  await writeFile(join(migrationsDir, '0001_a.sql'), 'CREATE TABLE a (id INTEGER);');
  await writeFile(join(migrationsDir, '0002_b.sql'), 'CREATE TABLE b (id INTEGER);');

  const db = createNodeSqliteDatabase(join(dir, 'partial.db'));
  await applyMigrations(db, migrationsDir);

  // Add a third migration; rerun. Only the new one should execute — the first
  // two would error if re-run because the tables already exist.
  await writeFile(join(migrationsDir, '0003_c.sql'), 'CREATE TABLE c (id INTEGER);');
  await applyMigrations(db, migrationsDir);

  const recorded = await db.prepare('SELECT name FROM _migrations ORDER BY name').all<{ name: string }>();
  assertEquals(recorded.results.map(r => r.name), ['0001_a.sql', '0002_b.sql', '0003_c.sql']);
}));
