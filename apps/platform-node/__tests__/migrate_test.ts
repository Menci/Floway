import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

test('rerun is a no-op once all migrations are applied', () => withTemp(async dir => {
  const db = createNodeSqliteDatabase(join(dir, 'idempotent.db'));
  await applyMigrations(db);
  const firstCount = await db.prepare('SELECT COUNT(*) AS n FROM _migrations').first<{ n: number }>();

  await applyMigrations(db);
  const secondCount = await db.prepare('SELECT COUNT(*) AS n FROM _migrations').first<{ n: number }>();
  assertEquals(secondCount?.n, firstCount?.n);
}));

test('OAuth2 access migration converts the former Gitea membership list to UserInfo group conditions', () => withTemp(async dir => {
  const db = createNodeSqliteDatabase(join(dir, 'oauth2-access.db'));
  await applyMigrations(db);
  await db.prepare(
    `INSERT INTO oauth2_providers (
       id, display_name, enabled, client_id, client_secret,
       authorization_endpoint, token_endpoint, userinfo_endpoint,
       scopes_json, client_authentication, user_id_claim, username_claim,
       authorization_params_json, access_policy_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    'gitea',
    'Gitea',
    1,
    'client',
    'secret',
    'https://gitea.example.com/login/oauth/authorize',
    'https://gitea.example.com/login/oauth/access_token',
    'https://gitea.example.com/login/oauth/userinfo',
    '["openid","groups"]',
    'client_secret_post',
    null,
    null,
    '{}',
    '{"type":"gitea","baseUrl":"https://gitea.example.com","allowedMemberships":["POPIPA-l10n:owners","canneed:owners"]}',
    '2026-08-19T00:00:00.000Z',
    '2026-08-19T00:00:00.000Z',
  ).run();

  const migration = await readFile(new URL('../../../packages/gateway/migrations/0086_oauth2_claim_access_policies.sql', import.meta.url), 'utf8');
  await db.exec(migration);

  const row = await db.prepare('SELECT access_policy_json FROM oauth2_providers WHERE id = ?')
    .bind('gitea')
    .first<{ access_policy_json: string }>();
  assertEquals(JSON.parse(row?.access_policy_json ?? ''), {
    logic: 'or',
    conditions: [
      { field: 'groups', op: 'contains', value: 'POPIPA-l10n:owners' },
      { field: 'groups', op: 'contains', value: 'canneed:owners' },
    ],
  });
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
