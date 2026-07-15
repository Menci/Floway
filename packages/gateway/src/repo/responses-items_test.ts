import { describe, expect, test } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { SqlRepo } from './sql.ts';
import { createSqliteTestDb } from './test-sqlite.ts';
import type { Repo, StoredResponsesItem } from './types.ts';
import { initFileProvider, MemoryFileProvider } from '@floway-dev/platform';

const factories: Array<[string, () => Promise<Repo>]> = [
  ['memory', async () => new InMemoryRepo()],
  ['sql', async () => new SqlRepo(await createSqliteTestDb())],
];

const storedItem = (id: string, apiKeyId: string, contentHash: string, createdAt: number): StoredResponsesItem => ({
  id,
  apiKeyId,
  itemType: 'message',
  payload: { item: { type: 'message', id, role: 'assistant', content: [] } },
  contentHash,
  createdAt,
});

describe.each(factories)('%s Responses state repo', (_name, createRepo) => {
  test('stores complete key-scoped items and looks them up by id and content hash', async () => {
    initFileProvider(new MemoryFileProvider());
    const repo = await createRepo();
    const first = storedItem('msg_first', 'key-a', 'hash-a', 1_000);
    const second = storedItem('msg_second', 'key-a', 'hash-b', 2_000);
    const other = storedItem('msg_other', 'key-b', 'hash-a', 3_000);

    await repo.responsesItems.insertMany([first, second, other]);

    expect(await repo.responsesItems.lookupMany('key-a', [second.id, first.id])).toEqual([second, first]);
    expect(await repo.responsesItems.lookupMany('key-b', [first.id])).toEqual([]);
    expect(await repo.responsesItems.lookupManyByContentHash('key-a', ['hash-a'])).toEqual([first]);
  });

  test('deletes complete items and snapshots by their shared creation-time retention', async () => {
    initFileProvider(new MemoryFileProvider());
    const repo = await createRepo();
    const old = storedItem('msg_old', 'key-a', 'old', 1_000);
    const fresh = storedItem('msg_fresh', 'key-a', 'fresh', 3_000);
    await repo.responsesItems.insertMany([old, fresh]);
    await repo.responsesSnapshots.insert({ id: 'resp_old', apiKeyId: 'key-a', itemIds: [old.id], createdAt: 1_000 });
    await repo.responsesSnapshots.insert({ id: 'resp_fresh', apiKeyId: 'key-a', itemIds: [fresh.id], createdAt: 3_000 });

    expect(await repo.responsesItems.deleteOlderThan(2_000)).toBe(1);
    expect(await repo.responsesSnapshots.deleteOlderThan(2_000)).toBe(1);
    expect(await repo.responsesItems.lookupMany('key-a', [old.id, fresh.id])).toEqual([fresh]);
    expect(await repo.responsesSnapshots.lookup('key-a', 'resp_old')).toBeNull();
    expect(await repo.responsesSnapshots.lookup('key-a', 'resp_fresh')).toEqual({
      id: 'resp_fresh', apiKeyId: 'key-a', itemIds: [fresh.id], createdAt: 3_000,
    });
  });
});
