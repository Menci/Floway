import initSqlJs from 'sql.js';
import { test } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { SqlRepo } from './sql.ts';
import { createSqliteTestDb, migrationSqlByFilename } from './test-sqlite.ts';
import type { ApiKey, Repo } from './types.ts';
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
  affinitySecret: '00'.repeat(32),
  createdAt: '2026-06-19T00:00:00.000Z',
  upstreamIds: null,
  deletedAt: null,
  dumpRetentionSeconds: null,
  ...overrides,
});

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

  test(`[${backend}] api keys repo round-trips affinitySecret`, async () => {
    const repo = await makeRepo();
    const secret = 'ab'.repeat(32);
    await repo.apiKeys.save(baseKey({ affinitySecret: secret }));
    assertEquals((await repo.apiKeys.findByRawKey('raw_dump_key'))?.affinitySecret, secret);

  });
}

test('migration 0056 backfills distinct affinity secrets and enforces their canonical form', async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  try {
    for (const [filename, sql] of migrationSqlByFilename) {
      if (filename === '0056_api_key_affinity_secret.sql') break;
      db.run(sql);
    }
    db.run(`
      INSERT INTO api_keys (id, user_id, name, key, created_at, upstream_ids, deleted_at, dump_retention_seconds)
      VALUES
        ('key_a', 1, 'A', 'raw_a', '2026-01-01T00:00:00.000Z', NULL, NULL, NULL),
        ('key_b', 1, 'B', 'raw_b', '2026-01-02T00:00:00.000Z', '["up_a"]', NULL, 3600)
    `);

    const migration = migrationSqlByFilename.find(([filename]) => filename === '0056_api_key_affinity_secret.sql');
    if (migration === undefined) throw new Error('missing migration 0056_api_key_affinity_secret.sql');
    db.run(migration[1]);

    const [result] = db.exec('SELECT id, upstream_ids, dump_retention_seconds, affinity_secret FROM api_keys ORDER BY id');
    if (result === undefined) throw new Error('migration 0056 returned no api_keys rows');
    const rows = result.values.map(values => Object.fromEntries(result.columns.map((column, index) => [column, values[index]]))) as Array<{
      id: string;
      upstream_ids: string | null;
      dump_retention_seconds: number | null;
      affinity_secret: string;
    }>;
    assertEquals(rows.map(row => [row.id, row.upstream_ids, row.dump_retention_seconds]), [
      ['key_a', null, null],
      ['key_b', '["up_a"]', 3600],
    ]);
    assertEquals(rows.every(row => /^[0-9a-f]{64}$/.test(row.affinity_secret)), true);
    assertEquals(rows[0]!.affinity_secret === rows[1]!.affinity_secret, false);

    assertThrows(
      () => db.run(`INSERT INTO api_keys (id, user_id, name, key, affinity_secret, created_at)
        VALUES ('bad', 1, 'Bad', 'raw_bad', '${'AB'.repeat(32)}', '2026-01-03T00:00:00.000Z')`),
      Error,
      'CHECK constraint failed',
    );
    assertThrows(
      () => db.run(`INSERT INTO api_keys (id, user_id, name, key, affinity_secret, created_at)
        VALUES ('duplicate', 1, 'Duplicate', 'raw_duplicate', '${rows[0]!.affinity_secret}', '2026-01-03T00:00:00.000Z')`),
      Error,
      'UNIQUE constraint failed: api_keys.affinity_secret',
    );
  } finally {
    db.close();
  }
});
