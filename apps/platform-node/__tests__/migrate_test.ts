import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test } from 'vitest';

import { applyMigrations } from '../src/migrate.ts';
import { createNodeSqliteDatabase } from '../src/node-sqlite-database.ts';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

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
