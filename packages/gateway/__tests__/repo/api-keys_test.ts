import { test } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { createSqliteTestDb, createSqlJsDatabase, migrationSqlByFilename } from './test-sqlite.ts';
import { SqlRepo } from '../../src/repo/sql.ts';
import type { ApiKey, Repo } from '../../src/repo/types.ts';
import type { SqlBindValue, SqlDatabase, SqlPreparedStatement, SqlResult } from '@floway-dev/platform';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';

const REPO_BACKENDS: Array<readonly [string, () => Promise<Repo>]> = [
  ['memory', async () => new InMemoryRepo()],
  ['sql', async () => new SqlRepo(await createSqliteTestDb())],
];

const baseKey = (overrides: Partial<ApiKey> = {}): ApiKey => ({
  id: 'key_dump',
  userId: 1,
  name: 'Dump key',
  key: 'raw_dump_key',
  serverSecret: '00'.repeat(32),
  createdAt: '2026-06-19T00:00:00.000Z',
  upstreamIds: null,
  deletedAt: null,
  dumpRetentionSeconds: null,
  responsesRetentionSeconds: 0,
  ...overrides,
});

// Both production SQLite adapters reject JavaScript booleans at bind time.
// sql.js accepts them, so this wrapper keeps the repository test honest about
// the scalar contract shared by node:sqlite and Cloudflare D1.
class ScalarOnlyPreparedStatement implements SqlPreparedStatement {
  constructor(private readonly inner: SqlPreparedStatement) {}

  bind(...values: SqlBindValue[]): SqlPreparedStatement {
    if (values.some(value => typeof value === 'boolean')) {
      throw new TypeError('JavaScript booleans are not SQLite-bindable values');
    }
    return new ScalarOnlyPreparedStatement(this.inner.bind(...values));
  }

  first<T = Record<string, unknown>>(): Promise<T | null> {
    return this.inner.first<T>();
  }

  all<T = Record<string, unknown>>(): Promise<SqlResult<T>> {
    return this.inner.all<T>();
  }

  run(): Promise<SqlResult> {
    return this.inner.run();
  }
}

class ScalarOnlySqlDatabase implements SqlDatabase {
  constructor(private readonly inner: SqlDatabase) {}

  prepare(query: string): SqlPreparedStatement {
    return new ScalarOnlyPreparedStatement(this.inner.prepare(query));
  }

  exec(sql: string): Promise<unknown> {
    return this.inner.exec(sql);
  }
}

for (const [backend, makeRepo] of REPO_BACKENDS) {
  test(`[${backend}] api keys repo defaults dumpRetentionSeconds to null on save`, async () => {
    const repo = await makeRepo();
    await repo.apiKeys.save(baseKey());
    assertEquals((await repo.apiKeys.getById('key_dump'))?.dumpRetentionSeconds, null);
  });

  test(`[${backend}] api keys repo round-trips and updates dumpRetentionSeconds across save/getById`, async () => {
    const repo = await makeRepo();
    await repo.apiKeys.save(baseKey({ dumpRetentionSeconds: 86_400 }));
    assertEquals((await repo.apiKeys.getById('key_dump'))?.dumpRetentionSeconds, 86_400);

    // Positive -> null (the column survives ON CONFLICT UPDATE).
    await repo.apiKeys.save(baseKey({ dumpRetentionSeconds: null }));
    assertEquals((await repo.apiKeys.getById('key_dump'))?.dumpRetentionSeconds, null);

    // Positive -> different positive (overwrite, not coalesce).
    await repo.apiKeys.save(baseKey({ dumpRetentionSeconds: 3600 }));
    await repo.apiKeys.save(baseKey({ dumpRetentionSeconds: 86_400 }));
    assertEquals((await repo.apiKeys.getById('key_dump'))?.dumpRetentionSeconds, 86_400);
  });

  test(`[${backend}] api keys repo read paths return the current dumpRetentionSeconds after an update`, async () => {
    const repo = await makeRepo();
    await repo.apiKeys.save(baseKey({ dumpRetentionSeconds: 3600 }));
    await repo.apiKeys.save(baseKey({ dumpRetentionSeconds: 86_400 }));

    const byRawKey = await repo.apiKeys.findByRawKey('raw_dump_key');
    assertEquals(byRawKey?.dumpRetentionSeconds, 86_400);

    const listed = await repo.apiKeys.list();
    assertEquals(listed.find(k => k.id === 'key_dump')?.dumpRetentionSeconds, 86_400);

    const listedAll = await repo.apiKeys.listIncludingDeleted();
    assertEquals(listedAll.find(k => k.id === 'key_dump')?.dumpRetentionSeconds, 86_400);

    const byUser = await repo.apiKeys.listByUserId(1);
    assertEquals(byUser.find(k => k.id === 'key_dump')?.dumpRetentionSeconds, 86_400);
  });

  test(`[${backend}] api keys repo round-trips serverSecret`, async () => {
    const repo = await makeRepo();
    const secret = 'ab'.repeat(32);
    await repo.apiKeys.save(baseKey({ serverSecret: secret }));
    assertEquals((await repo.apiKeys.findByRawKey('raw_dump_key'))?.serverSecret, secret);

  });

  test(`[${backend}] targeted Responses retention updates preserve unrelated fields`, async () => {
    const repo = await makeRepo();
    await repo.apiKeys.save(baseKey({ lastUsedAt: '2026-07-01T00:00:00.000Z' }));
    const updated = await repo.apiKeys.update('key_dump', { responsesRetentionSeconds: 7 * 24 * 60 * 60 });

    assertEquals(updated?.responsesRetentionSeconds, 7 * 24 * 60 * 60);
    assertEquals(updated?.lastUsedAt, '2026-07-01T00:00:00.000Z');
    assertEquals(updated?.dumpRetentionSeconds, null);
  });
}

test('[sql] targeted API key updates use SQLite-bindable scalar values', async () => {
  const repo = new SqlRepo(new ScalarOnlySqlDatabase(await createSqliteTestDb()));
  await repo.apiKeys.save(baseKey());

  const updated = await repo.apiKeys.update('key_dump', {
    name: 'Updated key',
    key: 'updated_raw_key',
    lastUsedAt: '2026-07-29T00:00:00.000Z',
    upstreamIds: ['upstream-a'],
    dumpRetentionSeconds: 3600,
    responsesRetentionSeconds: 7 * 24 * 60 * 60,
  });

  assertEquals(updated?.name, 'Updated key');
  assertEquals(updated?.key, 'updated_raw_key');
  assertEquals(updated?.lastUsedAt, '2026-07-29T00:00:00.000Z');
  assertEquals(updated?.upstreamIds, ['upstream-a']);
  assertEquals(updated?.dumpRetentionSeconds, 3600);
  assertEquals(updated?.responsesRetentionSeconds, 7 * 24 * 60 * 60);
});

test('migration 0057 backfills distinct server secrets and enforces their canonical form', async () => {
  const db = await createSqlJsDatabase();
  try {
    for (const [filename, sql] of migrationSqlByFilename) {
      if (filename === '0057_api_key_server_secret.sql') break;
      db.run(sql);
    }
    db.run(`
      INSERT INTO api_keys (id, user_id, name, key, created_at, upstream_ids, deleted_at, dump_retention_seconds)
      VALUES
        ('key_a', 1, 'A', 'raw_a', '2026-01-01T00:00:00.000Z', NULL, NULL, NULL),
        ('key_b', 1, 'B', 'raw_b', '2026-01-02T00:00:00.000Z', '["up_a"]', NULL, 3600)
    `);

    const migration = migrationSqlByFilename.find(([filename]) => filename === '0057_api_key_server_secret.sql');
    if (migration === undefined) throw new Error('missing migration 0057_api_key_server_secret.sql');
    db.run(migration[1]);

    const [result] = db.exec('SELECT id, upstream_ids, dump_retention_seconds, server_secret FROM api_keys ORDER BY id');
    if (result === undefined) throw new Error('migration 0057 returned no api_keys rows');
    const rows = result.values.map(values => Object.fromEntries(result.columns.map((column, index) => [column, values[index]]))) as Array<{
      id: string;
      upstream_ids: string | null;
      dump_retention_seconds: number | null;
      server_secret: string;
    }>;
    assertEquals(rows.map(row => [row.id, row.upstream_ids, row.dump_retention_seconds]), [
      ['key_a', null, null],
      ['key_b', '["up_a"]', 3600],
    ]);
    assertEquals(rows.every(row => /^[0-9a-f]{64}$/.test(row.server_secret)), true);
    assertEquals(rows[0]!.server_secret === rows[1]!.server_secret, false);

    assertThrows(
      () => db.run(`INSERT INTO api_keys (id, user_id, name, key, server_secret, created_at)
        VALUES ('bad', 1, 'Bad', 'raw_bad', '${'AB'.repeat(32)}', '2026-01-03T00:00:00.000Z')`),
      Error,
      'CHECK constraint failed',
    );
    assertThrows(
      () => db.run(`INSERT INTO api_keys (id, user_id, name, key, server_secret, created_at)
        VALUES ('duplicate', 1, 'Duplicate', 'raw_duplicate', '${rows[0]!.server_secret}', '2026-01-03T00:00:00.000Z')`),
      Error,
      'UNIQUE constraint failed: api_keys.server_secret',
    );
  } finally {
    db.close();
  }
});
