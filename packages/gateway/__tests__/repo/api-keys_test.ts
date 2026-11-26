import { test } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { createSqliteTestDb } from './test-sqlite.ts';
import { SqlRepo } from '../../src/repo/sql.ts';
import type { ApiKey, Repo } from '../../src/repo/types.ts';
import type { SqlBindValue, SqlDatabase, SqlPreparedStatement, SqlResult } from '@floway-dev/platform';
import { assertEquals } from '@floway-dev/test-utils';

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
  randomizeUpstreams: false,
  deletedAt: null,
  dumpRetentionSeconds: null,
  openaiResponsesRetentionSeconds: 0,
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
  test(`[${backend}] api keys preserve empty upstream restrictions across save and update`, async () => {
    const repo = await makeRepo();
    await repo.apiKeys.save(baseKey({ upstreamIds: [] }));
    assertEquals((await repo.apiKeys.findByRawKey('raw_dump_key'))?.upstreamIds, []);

    await repo.apiKeys.update('key_dump', { upstreamIds: null });
    assertEquals((await repo.apiKeys.getById('key_dump'))?.upstreamIds, null);

    await repo.apiKeys.update('key_dump', { upstreamIds: [] });
    assertEquals((await repo.apiKeys.getById('key_dump'))?.upstreamIds, []);
  });

}

test('[sql] targeted API key updates use SQLite-bindable scalar values', async () => {
  const repo = new SqlRepo(new ScalarOnlySqlDatabase(await createSqliteTestDb()));
  await repo.apiKeys.save(baseKey());

  const updated = await repo.apiKeys.update('key_dump', {
    name: 'Updated key',
    key: 'updated_raw_key',
    upstreamIds: ['upstream-a'],
    randomizeUpstreams: true,
    dumpRetentionSeconds: 3600,
    openaiResponsesRetentionSeconds: 7 * 24 * 60 * 60,
  });

  assertEquals(updated?.name, 'Updated key');
  assertEquals(updated?.key, 'updated_raw_key');
  assertEquals(updated?.upstreamIds, ['upstream-a']);
  assertEquals(updated?.randomizeUpstreams, true);
  assertEquals(updated?.dumpRetentionSeconds, 3600);
  assertEquals(updated?.openaiResponsesRetentionSeconds, 7 * 24 * 60 * 60);
});
