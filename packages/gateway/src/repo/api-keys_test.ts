import { test } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { SqlRepo } from './sql.ts';
import { createSqliteTestDb } from './test-sqlite.ts';
import type { ApiKey, Repo } from './types.ts';
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
}
