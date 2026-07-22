import initSqlJs from 'sql.js';
import { describe, expect, test, vi } from 'vitest';

import { initRepo } from './index.ts';
import { InMemoryRepo } from './memory.ts';
import { sweepResponsesState } from './responses-maintenance.ts';
import { prepareStoredResponsesPayload } from './responses-payload.ts';
import { SqlRepo } from './sql.ts';
import { createSqliteTestDb, migrationSqlByFilename } from './test-sqlite.ts';
import type { ApiKey, Repo, StoredResponsesItem } from './types.ts';
import { testResponsesStateLifetime, TEST_RESPONSES_RETENTION_SECONDS, TEST_RESPONSES_STATE_EPOCH } from '../test-helpers/responses-state.ts';
import { initFileProvider, MemoryFileProvider, type SqlDatabase, type SqlPreparedStatement } from '@floway-dev/platform';

const testApiKey = (id: string): ApiKey => ({
  id,
  userId: 1,
  name: id,
  key: `raw-${id}`,
  serverSecret: id === 'key-a' ? '11'.repeat(32) : '22'.repeat(32),
  createdAt: '2026-01-01T00:00:00.000Z',
  upstreamIds: null,
  deletedAt: null,
  dumpRetentionSeconds: null,
  responsesRetentionSeconds: TEST_RESPONSES_RETENTION_SECONDS,
  responsesStateEpoch: TEST_RESPONSES_STATE_EPOCH,
  responsesStateVisibleAfter: 0,
});

const enableResponses = async (repo: Repo, ...ids: string[]): Promise<void> => {
  for (const id of ids) await repo.apiKeys.save(testApiKey(id));
};

const factories: Array<[string, () => Promise<Repo>]> = [
  ['memory', async () => {
    const repo = new InMemoryRepo();
    await enableResponses(repo, 'key-a', 'key-b');
    return repo;
  }],
  ['sql', async () => {
    const repo = new SqlRepo(await createSqliteTestDb());
    await enableResponses(repo, 'key-a', 'key-b');
    return repo;
  }],
];

const storedItem = (id: string, apiKeyId: string, contentHash: string, refreshedAt: number): StoredResponsesItem => {
  const payload = { item: { type: 'message', id, role: 'assistant', content: [] } };
  return {
    id,
    apiKeyId,
    stateEpoch: TEST_RESPONSES_STATE_EPOCH,
    payload,
    contentHash,
    payloadHash: JSON.stringify(payload),
    payloadFileKey: null,
    ...testResponsesStateLifetime(refreshedAt),
  };
};

const spilledItem = (id: string, apiKeyId: string, refreshedAt: number): StoredResponsesItem => {
  const bytes = new Uint8Array(128 * 1024);
  crypto.getRandomValues(bytes.subarray(0, 64 * 1024));
  crypto.getRandomValues(bytes.subarray(64 * 1024));
  let content = '';
  for (const byte of bytes) content += byte.toString(16).padStart(2, '0');
  const payload = { item: { type: 'message', id, role: 'assistant', content } };
  return {
    ...storedItem(id, apiKeyId, `${id}-hash`, refreshedAt),
    payload,
    payloadHash: `${id}-payload-hash`,
    payloadFileKey: 'spilled',
  };
};

const payloadJson = async (item: StoredResponsesItem): Promise<string> =>
  (await prepareStoredResponsesPayload(item.id, item.apiKeyId, item.stateEpoch, item.payload)).payloadJson;

const sqlDatabaseWithBatch = (
  base: SqlDatabase,
  runBatch: (statements: SqlPreparedStatement[]) => Promise<Awaited<ReturnType<NonNullable<SqlDatabase['batch']>>>>,
): SqlDatabase => ({
  prepare: query => base.prepare(query),
  exec: sql => base.exec(sql),
  batch: runBatch,
});

const sqlDatabaseWithAllHook = (
  base: SqlDatabase,
  beforeAll: (query: string) => Promise<void>,
): SqlDatabase => ({
  prepare: query => {
    const wrap = (statement: SqlPreparedStatement): SqlPreparedStatement => ({
      bind: (...values) => wrap(statement.bind(...values)),
      first: <T>() => statement.first<T>(),
      all: async <T>() => {
        await beforeAll(query);
        return await statement.all<T>();
      },
      run: () => statement.run(),
    });
    return wrap(base.prepare(query));
  },
  exec: sql => base.exec(sql),
  ...(base.batch === undefined ? {} : { batch: base.batch.bind(base) }),
});

class DeleteHookFileProvider extends MemoryFileProvider {
  beforeDelete: ((keys: readonly string[]) => Promise<void>) | undefined;

  override async deleteKeys(keys: readonly string[]): Promise<void> {
    const beforeDelete = this.beforeDelete;
    this.beforeDelete = undefined;
    await beforeDelete?.(keys);
    await super.deleteKeys(keys);
  }
}

describe.each(factories)('%s Responses state repo', (_name, createRepo) => {
  test('stores complete key-scoped items and looks them up by id and content hash', async () => {
    initFileProvider(new MemoryFileProvider());
    const repo = await createRepo();
    const first = storedItem('msg_first', 'key-a', 'hash-a', 1_000);
    const second = storedItem('msg_second', 'key-a', 'hash-b', 2_000);
    const other = storedItem('msg_other', 'key-b', 'hash-a', 3_000);
    await repo.responsesItems.insertMany([first, second, other], 0);

    expect(await repo.responsesItems.lookupMany('key-a', TEST_RESPONSES_STATE_EPOCH, [second.id, first.id])).toEqual([second, first]);
    expect(await repo.responsesItems.lookupMany('key-b', TEST_RESPONSES_STATE_EPOCH, [first.id])).toEqual([]);
    expect(await repo.responsesItems.lookupManyByContentHash('key-a', TEST_RESPONSES_STATE_EPOCH, ['hash-a'])).toEqual([first]);
  });

  test('exact producer-id reuse is idempotent and refreshes the item lifetime', async () => {
    initFileProvider(new MemoryFileProvider());
    const repo = await createRepo();
    const first = storedItem('msg_reused', 'key-a', 'same-hash', 1_000);
    const refreshed = { ...first, refreshedAt: 3_000 };

    await repo.responsesItems.insertMany([first], 0);
    await repo.responsesItems.insertMany([refreshed], 0);

    expect(await repo.responsesItems.lookupMany('key-a', TEST_RESPONSES_STATE_EPOCH, [first.id])).toEqual([refreshed]);
  });

  test('an expired producer id can be reused for a different item', async () => {
    initFileProvider(new MemoryFileProvider());
    const repo = await createRepo();
    const expired = storedItem('msg_recycled', 'key-a', 'old-content', 1_000);
    await repo.responsesItems.insertMany([expired], 0);
    const replacementBase = storedItem(expired.id, expired.apiKeyId, 'new-content', 3_000);
    const payload = { item: { type: 'message', id: expired.id, role: 'assistant', content: [{ type: 'output_text', text: 'new' }] } };
    const replacement = { ...replacementBase, payload, payloadHash: JSON.stringify(payload) };

    await repo.responsesItems.insertMany([replacement], 2_000);

    expect(await repo.responsesItems.lookupMany('key-a', TEST_RESPONSES_STATE_EPOCH, [expired.id])).toEqual([replacement]);
  });

  test.each([
    ['visible payload', (first: StoredResponsesItem): StoredResponsesItem => ({
      ...first,
      payload: { item: { type: 'message', id: first.id, role: 'assistant', content: [{ type: 'output_text', text: 'different' }] } },
      contentHash: 'different-hash',
    })],
    ['private payload', (first: StoredResponsesItem): StoredResponsesItem => ({
      ...first,
      payload: { ...first.payload, private: { replay: 'different' } },
      payloadHash: 'different-private-payload-hash',
    })],
  ] as const)('rejects a producer-id collision with different %s', async (_kind, collide) => {
    initFileProvider(new MemoryFileProvider());
    const repo = await createRepo();
    const first = storedItem('msg_collision', 'key-a', 'same-hash', 1_000);
    await repo.responsesItems.insertMany([first], 0);

    await expect(repo.responsesItems.insertMany([collide(first)], 0))
      .rejects.toThrow(`Responses item id collision: ${first.id}`);
    expect(await repo.responsesItems.lookupMany('key-a', TEST_RESPONSES_STATE_EPOCH, [first.id])).toEqual([first]);
  });

  test('rejects conflicting duplicate ids within one insert batch', async () => {
    initFileProvider(new MemoryFileProvider());
    const repo = await createRepo();
    const first = storedItem('msg_batch_collision', 'key-a', 'first-hash', 1_000);
    const second = { ...first, contentHash: 'second-hash', payload: { item: { type: 'message', id: first.id, content: 'different' } } };

    await expect(repo.responsesItems.insertMany([first, second], 0))
      .rejects.toThrow(`Responses item id collision: ${first.id}`);
    expect(await repo.responsesItems.lookupMany('key-a', TEST_RESPONSES_STATE_EPOCH, [first.id])).toEqual([]);
  });

  test('deletes complete items and snapshots by their refreshable retention timestamp', async () => {
    initFileProvider(new MemoryFileProvider());
    const repo = await createRepo();
    const old = storedItem('msg_old', 'key-a', 'old', 1_000);
    const fresh = storedItem('msg_fresh', 'key-a', 'fresh', 3_000);
    await repo.responsesItems.insertMany([old, fresh], 0);
    await repo.responsesSnapshots.insert({ id: 'resp_old', apiKeyId: 'key-a', stateEpoch: TEST_RESPONSES_STATE_EPOCH, itemIds: [old.id], ...testResponsesStateLifetime(1_000) });
    await repo.responsesSnapshots.insert({ id: 'resp_fresh', apiKeyId: 'key-a', stateEpoch: TEST_RESPONSES_STATE_EPOCH, itemIds: [fresh.id], ...testResponsesStateLifetime(3_000) });

    expect(await repo.responsesItems.deleteReclaimable('key-a', TEST_RESPONSES_RETENTION_SECONDS * 1000 + 2_000, 100)).toBe(1);
    expect(await repo.responsesSnapshots.deleteReclaimable('key-a', TEST_RESPONSES_RETENTION_SECONDS * 1000 + 2_000, 100)).toBe(1);
    expect(await repo.responsesItems.lookupMany('key-a', TEST_RESPONSES_STATE_EPOCH, [old.id, fresh.id])).toEqual([fresh]);
    expect(await repo.responsesSnapshots.lookup('key-a', TEST_RESPONSES_STATE_EPOCH, 'resp_old')).toBeNull();
    expect(await repo.responsesSnapshots.lookup('key-a', TEST_RESPONSES_STATE_EPOCH, 'resp_fresh')).toEqual({
      id: 'resp_fresh', apiKeyId: 'key-a', stateEpoch: TEST_RESPONSES_STATE_EPOCH, itemIds: [fresh.id], ...testResponsesStateLifetime(3_000),
    });
  });

  test('a key-only lifetime refresh rejects an item that expired concurrently', async () => {
    initFileProvider(new MemoryFileProvider());
    const repo = await createRepo();
    const item = storedItem('msg_missing', 'key-a', 'missing', 1_000);
    await repo.responsesItems.insertMany([item], 0);
    await repo.responsesItems.deleteReclaimable('key-a', TEST_RESPONSES_RETENTION_SECONDS * 1000 + 2_000, 100);

    await expect(repo.responsesItems.refreshMany([item], 3_000))
      .rejects.toThrow('Responses item disappeared');
  });

  test('snapshot upsert refreshes its timestamp and item graph', async () => {
    initFileProvider(new MemoryFileProvider());
    const repo = await createRepo();
    await repo.responsesSnapshots.insert({ id: 'resp_same', apiKeyId: 'key-a', stateEpoch: TEST_RESPONSES_STATE_EPOCH, itemIds: ['msg_old'], ...testResponsesStateLifetime(1_000) });
    await repo.responsesSnapshots.insert({ id: 'resp_same', apiKeyId: 'key-a', stateEpoch: TEST_RESPONSES_STATE_EPOCH, itemIds: ['msg_new'], ...testResponsesStateLifetime(3_000) });
    await repo.responsesSnapshots.insert({ id: 'resp_same', apiKeyId: 'key-a', stateEpoch: TEST_RESPONSES_STATE_EPOCH, itemIds: ['msg_stale'], ...testResponsesStateLifetime(2_000) });

    expect(await repo.responsesSnapshots.lookup('key-a', TEST_RESPONSES_STATE_EPOCH, 'resp_same')).toEqual({
      id: 'resp_same', apiKeyId: 'key-a', stateEpoch: TEST_RESPONSES_STATE_EPOCH, itemIds: ['msg_new'], ...testResponsesStateLifetime(3_000),
    });
  });

  test('item refresh never lowers an existing lifetime', async () => {
    initFileProvider(new MemoryFileProvider());
    const repo = await createRepo();
    const item = storedItem('msg_monotonic', 'key-a', 'monotonic', 1_000);
    await repo.responsesItems.insertMany([item], 0);
    await repo.responsesItems.refreshMany([item], 3_000);
    await repo.responsesItems.refreshMany([item], 2_000);

    expect((await repo.responsesItems.lookupMany('key-a', TEST_RESPONSES_STATE_EPOCH, [item.id]))[0].refreshedAt).toBe(3_000);
  });

  test('refreshes spilled payload lifetime without touching file storage', async () => {
    const files = new MemoryFileProvider();
    initFileProvider(files);
    const repo = await createRepo();
    const item = spilledItem('msg_large', 'key-a', 1_000);
    await repo.responsesItems.insertMany([item], 0);
    const before = await files.listKeys('responses-items/');
    const put = vi.spyOn(files, 'put');
    const get = vi.spyOn(files, 'get');
    const deleteKeys = vi.spyOn(files, 'deleteKeys');
    await repo.responsesItems.refreshMany([item], 1_000 + 10 * 60 * 1000);
    await repo.responsesItems.refreshMany([item], 1_000 + 2 * 60 * 60 * 1000);
    const after = await files.listKeys('responses-items/');
    await repo.responsesItems.refreshMany([item], 1_000 + 60 * 60 * 1000);
    const afterOlderRefresh = await files.listKeys('responses-items/');

    expect(put).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(deleteKeys).not.toHaveBeenCalled();
    if (_name === 'sql') {
      expect(before).toHaveLength(1);
      expect(after).toEqual(before);
      expect(afterOlderRefresh).toEqual(after);
    } else {
      expect(before).toEqual([]);
      expect(after).toEqual([]);
      expect(afterOlderRefresh).toEqual([]);
    }
    expect((await repo.responsesItems.lookupMany('key-a', TEST_RESPONSES_STATE_EPOCH, [item.id]))[0].refreshedAt).toBe(1_000 + 2 * 60 * 60 * 1000);
  });
});

test('SQL refresh cleans a replacement spill when the row disappears before update', async () => {
  const files = new MemoryFileProvider();
  initFileProvider(files);
  const base = await createSqliteTestDb();
  let deleteBeforeBatch = false;
  const db = sqlDatabaseWithAllHook(base, async query => {
    if (!deleteBeforeBatch || !query.includes('UPDATE responses_state_items')) return;
    deleteBeforeBatch = false;
    await base.prepare('DELETE FROM responses_state_items WHERE id = ? AND api_key_id = ? AND state_epoch = ?')
      .bind('msg_race', 'key-a', TEST_RESPONSES_STATE_EPOCH)
      .run();
  });
  const repo = new SqlRepo(db);
  await enableResponses(repo, 'key-a');
  const item = spilledItem('msg_race', 'key-a', 1_000);
  await repo.responsesItems.insertMany([item], 0);
  const originalFiles = await files.listKeys('responses-items/');
  expect(originalFiles).toHaveLength(1);

  deleteBeforeBatch = true;
  await expect(repo.responsesItems.refreshMany(
    [item],
    1_000 + 2 * 60 * 60 * 1000,
  )).rejects.toThrow('Responses item disappeared or changed before lifetime refresh: msg_race');

  expect(await files.listKeys('responses-items/')).toEqual(originalFiles);
  expect(await repo.responsesItems.lookupMany('key-a', TEST_RESPONSES_STATE_EPOCH, [item.id])).toEqual([]);
});

test('SQL stale refresh preserves a newer concurrent lifetime', async () => {
  const files = new MemoryFileProvider();
  initFileProvider(files);
  const base = await createSqliteTestDb();
  const item = spilledItem('msg_refresh_cas', 'key-a', 1_000);
  const baseRepo = new SqlRepo(base);
  await enableResponses(baseRepo, 'key-a');
  await baseRepo.responsesItems.insertMany([item], 0);
  const staleGate = Promise.withResolvers<void>();
  const staleStarted = Promise.withResolvers<void>();
  let updateNumber = 0;
  const repo = new SqlRepo(sqlDatabaseWithAllHook(base, async query => {
    if (!query.includes('UPDATE responses_state_items')) return;
    updateNumber += 1;
    if (updateNumber === 1) {
      staleStarted.resolve();
      await staleGate.promise;
    }
  }));
  const staleRefreshedAt = 1_000 + 10 * 60 * 1000;
  const currentRefreshedAt = 1_000 + 2 * 60 * 60 * 1000;

  const staleRefresh = repo.responsesItems.refreshMany([item], staleRefreshedAt);
  await staleStarted.promise;
  await repo.responsesItems.refreshMany([item], currentRefreshedAt);
  staleGate.resolve();
  await staleRefresh;

  const [persisted] = await repo.responsesItems.lookupMany('key-a', TEST_RESPONSES_STATE_EPOCH, [item.id]);
  expect(persisted.refreshedAt).toBe(currentRefreshedAt);
  expect(persisted.payload).toEqual(item.payload);
  expect(await files.listKeys('responses-items/')).toHaveLength(1);
});

test('SQL newer refresh wins after an older concurrent lifetime update', async () => {
  const files = new MemoryFileProvider();
  initFileProvider(files);
  const base = await createSqliteTestDb();
  const item = spilledItem('msg_refresh_retry', 'key-a', 1_000);
  const baseRepo = new SqlRepo(base);
  await enableResponses(baseRepo, 'key-a');
  await baseRepo.responsesItems.insertMany([item], 0);
  const newerGate = Promise.withResolvers<void>();
  const newerStarted = Promise.withResolvers<void>();
  let updateNumber = 0;
  const repo = new SqlRepo(sqlDatabaseWithAllHook(base, async query => {
    if (!query.includes('UPDATE responses_state_items')) return;
    updateNumber += 1;
    if (updateNumber === 1) {
      newerStarted.resolve();
      await newerGate.promise;
    }
  }));
  const olderRefreshedAt = 1_000 + 60 * 60 * 1000;
  const newerRefreshedAt = 1_000 + 2 * 60 * 60 * 1000;

  const newerRefresh = repo.responsesItems.refreshMany([item], newerRefreshedAt);
  await newerStarted.promise;
  await repo.responsesItems.refreshMany([item], olderRefreshedAt);
  newerGate.resolve();
  await newerRefresh;

  const [persisted] = await repo.responsesItems.lookupMany('key-a', TEST_RESPONSES_STATE_EPOCH, [item.id]);
  expect(persisted.refreshedAt).toBe(newerRefreshedAt);
  expect(persisted.payload).toEqual(item.payload);
  expect(await files.listKeys('responses-items/')).toHaveLength(1);
});

test('SQL Responses item writes stay within D1 bind limits and use bounded statement counts', async () => {
  initFileProvider(new MemoryFileProvider());
  const base = await createSqliteTestDb();
  const batchSizes: number[] = [];
  let maxBindCount = 0;
  const db: SqlDatabase = {
    prepare: query => {
      const statement = base.prepare(query);
      return {
        bind: (...values) => {
          maxBindCount = Math.max(maxBindCount, values.length);
          return statement.bind(...values);
        },
        first: <T>() => statement.first<T>(),
        all: <T>() => statement.all<T>(),
        run: () => statement.run(),
      };
    },
    exec: sql => base.exec(sql),
    batch: async statements => {
      batchSizes.push(statements.length);
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  };
  const repo = new SqlRepo(db);
  await enableResponses(repo, 'key-a');
  const items = Array.from({ length: 240 }, (_, index) =>
    storedItem(`msg_bulk_${index}`, 'key-a', `hash-${index}`, 1_000));

  await repo.responsesItems.insertMany(items, 0);
  await repo.responsesItems.refreshMany(items, 2_000);

  expect(batchSizes).toEqual([4]);
  expect(maxBindCount).toBeLessThanOrEqual(100);
  expect(await repo.responsesItems.lookupMany('key-a', TEST_RESPONSES_STATE_EPOCH, items.map(item => item.id))).toHaveLength(items.length);
});

test('SQL refresh probes exact item identities instead of scanning the key retention range', async () => {
  const db = await createSqliteTestDb();
  const { results } = await db
    .prepare(
      `EXPLAIN QUERY PLAN
       WITH expected AS (
         SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.payloadHash') AS payload_hash
         FROM json_each(?)
       )
       SELECT stored.rowid
       FROM expected
       CROSS JOIN responses_state_items AS stored INDEXED BY idx_responses_state_items_id_scope
       WHERE stored.id = expected.id
         AND stored.api_key_id = ?
         AND stored.state_epoch = ?
         AND stored.payload_hash = expected.payload_hash`,
    )
    .bind('[{"id":"msg_x","payloadHash":"hash"}]', 'key-a', TEST_RESPONSES_STATE_EPOCH)
    .all<{ detail: string }>();
  const detail = results.map(row => row.detail).join('\n');
  expect(detail).toContain('idx_responses_state_items_id_scope');
  expect(detail).not.toContain('idx_responses_state_items_key_refresh');
});

test('SQL rejects a persistence graph that would exceed its D1 query budget', async () => {
  initFileProvider(new MemoryFileProvider());
  const repo = new SqlRepo(await createSqliteTestDb());
  const items = Array.from({ length: 1_501 }, (_, index) =>
    storedItem(`msg_over_budget_${index}`, 'key-a', `hash-${index}`, 1_000));

  await expect(repo.responsesItems.insertMany(items, 0))
    .rejects.toThrow('Responses state write exceeds 1500 items');
});

test('SQL real spilled writes stay within the reserved D1 and R2 budgets', async () => {
  const files = new MemoryFileProvider();
  initFileProvider(files);
  const put = vi.spyOn(files, 'put');
  const base = await createSqliteTestDb();
  let queries = 0;
  const wrap = (statement: SqlPreparedStatement): SqlPreparedStatement => ({
    bind: (...values) => wrap(statement.bind(...values)),
    first: async <T>() => {
      queries += 1;
      return await statement.first<T>();
    },
    all: async <T>() => {
      queries += 1;
      return await statement.all<T>();
    },
    run: async () => {
      queries += 1;
      return await statement.run();
    },
  });
  const repo = new SqlRepo({ prepare: query => wrap(base.prepare(query)), exec: sql => base.exec(sql) });
  await enableResponses(repo, 'key-a');
  queries = 0;
  const items = Array.from({ length: 20 }, (_, index) => spilledItem(`msg_spill_budget_${index}`, 'key-a', 1_000));

  await repo.responsesItems.insertMany(items, 0);

  expect(queries).toBeLessThanOrEqual(5);
  expect(put).toHaveBeenCalledTimes(items.length);
  queries = 0;
  put.mockClear();
  await repo.responsesItems.refreshMany(items, 2_000);
  expect(queries).toBe(1);
  expect(put).not.toHaveBeenCalled();
});

test('SQL insert cleans earlier spills when a later payload cannot be serialized', async () => {
  const files = new MemoryFileProvider();
  initFileProvider(files);
  const repo = new SqlRepo(await createSqliteTestDb());
  const circular: Record<string, unknown> = { type: 'message', id: 'msg_circular' };
  circular.self = circular;
  const invalid: StoredResponsesItem = {
    ...storedItem('msg_circular', 'key-a', 'circular', 1_000),
    payload: { item: circular },
  };

  await expect(repo.responsesItems.insertMany([spilledItem('msg_before_circular', 'key-a', 1_000), invalid], 0))
    .rejects.toThrow();

  expect(await files.listKeys('responses-items/')).toEqual([]);
});

test('SQL insert cleans generated spills when its batch fails', async () => {
  const files = new MemoryFileProvider();
  initFileProvider(files);
  const base = await createSqliteTestDb();
  const batchFailure = new Error('simulated insert batch failure');
  const repo = new SqlRepo(sqlDatabaseWithBatch(base, () => Promise.reject(batchFailure)));

  await expect(repo.responsesItems.insertMany([spilledItem('msg_insert_failure', 'key-a', 1_000)], 0))
    .rejects.toBe(batchFailure);

  expect(await files.listKeys('responses-items/')).toEqual([]);
});

test('SQL payload GC reclaims a staged object left before item adoption', async () => {
  const files = new MemoryFileProvider();
  initFileProvider(files);
  const base = await createSqliteTestDb();
  const repo = new SqlRepo(base);
  initRepo(repo);
  const item = spilledItem('msg_crash_orphan', 'key-a', 1_000);
  const prepared = await prepareStoredResponsesPayload(item.id, item.apiKeyId, item.stateEpoch, item.payload);
  if (prepared.file === null) throw new Error('expected spilled payload');
  await base.prepare('INSERT INTO responses_state_payload_gc (file_key, eligible_at) VALUES (?, 0)')
    .bind(prepared.file.key)
    .run();
  await files.put(prepared.file.key, prepared.file.body);

  await sweepResponsesState(Date.now());

  expect(await files.get(prepared.file.key)).toBeNull();
  expect((await base.prepare('SELECT COUNT(*) AS count FROM responses_state_payload_gc').first<{ count: number }>())?.count).toBe(0);
});

test('SQL rejects payload adoption after GC has claimed its staging row', async () => {
  const files = new MemoryFileProvider();
  initFileProvider(files);
  const base = await createSqliteTestDb();
  const repo = new SqlRepo(base);
  const item = spilledItem('msg_late_adoption', 'key-a', 1_000);
  const prepared = await prepareStoredResponsesPayload(item.id, item.apiKeyId, item.stateEpoch, item.payload);
  const file = prepared.file;
  if (file === null) throw new Error('expected spilled payload');
  await base.prepare('INSERT INTO responses_state_payload_gc (file_key, eligible_at) VALUES (?, 0)')
    .bind(file.key)
    .run();
  expect(await repo.responsesMaintenance.claimPayloadFiles('claim', 1, 0, 100)).toEqual([file.key]);
  await files.put(file.key, file.body);

  await expect(async () => await base.prepare(
    `INSERT INTO responses_state_items (${['id', 'api_key_id', 'state_epoch', 'payload_json', 'content_hash', 'payload_hash', 'payload_file_key', 'refreshed_at'].join(', ')})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    item.id,
    item.apiKeyId,
    item.stateEpoch,
    prepared.payloadJson,
    item.contentHash,
    item.payloadHash,
    file.key,
    item.refreshedAt,
  ).run()).rejects.toThrow('Responses payload file was not staged');
});

test('SQL refresh failure leaves stable payload files untouched', async () => {
  const files = new MemoryFileProvider();
  initFileProvider(files);
  const base = await createSqliteTestDb();
  const originalRepo = new SqlRepo(base);
  await enableResponses(originalRepo, 'key-a');
  const item = spilledItem('msg_refresh_failure', 'key-a', 1_000);
  await originalRepo.responsesItems.insertMany([item], 0);
  const originalFiles = await files.listKeys('responses-items/');
  const batchFailure = new Error('simulated refresh batch failure');
  const repo = new SqlRepo(sqlDatabaseWithAllHook(base, query =>
    query.includes('UPDATE responses_state_items') ? Promise.reject(batchFailure) : Promise.resolve()));

  await expect(repo.responsesItems.refreshMany(
    [item],
    1_000 + 2 * 60 * 60 * 1000,
  ))
    .rejects.toBe(batchFailure);

  expect(await files.listKeys('responses-items/')).toEqual(originalFiles);
});

test('SQL exact duplicate refreshes its spill lifetime without rewriting the file', async () => {
  const files = new MemoryFileProvider();
  initFileProvider(files);
  const repo = new SqlRepo(await createSqliteTestDb());
  await enableResponses(repo, 'key-a');
  const original = spilledItem('msg_duplicate', 'key-a', 1_000);
  await repo.responsesItems.insertMany([original], 0);
  const originalFiles = await files.listKeys('responses-items/');
  expect(originalFiles).toHaveLength(1);

  const put = vi.spyOn(files, 'put');
  const refreshedAt = 1_000 + 2 * 60 * 60 * 1000;
  await repo.responsesItems.insertMany([{ ...original, refreshedAt }], 0);

  expect(put).not.toHaveBeenCalled();
  const refreshedFiles = await files.listKeys('responses-items/');
  expect(refreshedFiles).toEqual(originalFiles);
  expect((await repo.responsesItems.lookupMany('key-a', TEST_RESPONSES_STATE_EPOCH, [original.id]))[0]).toMatchObject({
    id: original.id,
    payload: original.payload,
    contentHash: original.contentHash,
    payloadHash: original.payloadHash,
    refreshedAt,
  });
});

test('SQL expired spill replacement queues and reclaims the old file', async () => {
  const files = new MemoryFileProvider();
  initFileProvider(files);
  const repo = new SqlRepo(await createSqliteTestDb());
  await enableResponses(repo, 'key-a');
  initRepo(repo);
  const expired = spilledItem('msg_expired_spill', 'key-a', 1_000);
  await repo.responsesItems.insertMany([expired], 0);
  expect(await files.listKeys('responses-items/')).toHaveLength(1);
  const replacementBase = storedItem(expired.id, expired.apiKeyId, 'replacement-content', 3_000);
  const payload = { item: { type: 'message', id: expired.id, role: 'assistant', content: [{ type: 'output_text', text: 'replacement' }] } };
  const replacement = { ...replacementBase, payload, payloadHash: JSON.stringify(payload) };

  await repo.responsesItems.insertMany([replacement], 2_000);

  expect(await files.listKeys('responses-items/')).toHaveLength(1);
  await sweepResponsesState(3_000);
  expect(await files.listKeys('responses-items/')).toEqual([]);
  expect(await repo.responsesItems.lookupMany('key-a', TEST_RESPONSES_STATE_EPOCH, [expired.id])).toEqual([replacement]);
});

test('SQL insert conflict cleans its spill when the winning row disappears', async () => {
  const files = new MemoryFileProvider();
  initFileProvider(files);
  const base = await createSqliteTestDb();
  const inlinePayload = await payloadJson(storedItem('msg_insert_race', 'key-a', 'race', 1_000));
  let injectConflict = true;
  const db: SqlDatabase = {
    prepare: query => base.prepare(query),
    exec: sql => base.exec(sql),
    batch: async statements => {
      if (!injectConflict) throw new Error('unexpected second insert batch');
      injectConflict = false;
      const insertWinner = base.prepare(
        `INSERT INTO responses_state_items
          (id, api_key_id, state_epoch, payload_json, content_hash, payload_hash, payload_file_key, refreshed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      await insertWinner.bind('msg_insert_race', 'key-a', TEST_RESPONSES_STATE_EPOCH, inlinePayload, 'race', 'race-payload', null, 1_000).run();
      await insertWinner.bind('msg_insert_survivor', 'key-a', TEST_RESPONSES_STATE_EPOCH, inlinePayload, 'survivor', 'survivor-payload', null, 1_000).run();
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      await base.prepare('DELETE FROM responses_state_items WHERE id = ? AND api_key_id = ? AND state_epoch = ?')
        .bind('msg_insert_race', 'key-a', TEST_RESPONSES_STATE_EPOCH)
        .run();
      return results;
    },
  };
  const repo = new SqlRepo(db);
  const item = spilledItem('msg_insert_race', 'key-a', 1_000 + 2 * 60 * 60 * 1000);
  const survivor = spilledItem('msg_insert_survivor', 'key-a', 1_000 + 2 * 60 * 60 * 1000);

  await expect(repo.responsesItems.insertMany([item, survivor], 0))
    .rejects.toThrow('Responses item conflict disappeared before spill cleanup: msg_insert_race');
  expect(await files.listKeys('responses-items/')).toEqual([]);
});

test('SQL rejects a different concurrent winner and cleans the losing spill', async () => {
  const files = new MemoryFileProvider();
  initFileProvider(files);
  const base = await createSqliteTestDb();
  const contender = spilledItem('msg_concurrent_collision', 'key-a', 2_000);
  const winner = storedItem(contender.id, contender.apiKeyId, 'winner-hash', 1_000);
  const winnerPayload = await payloadJson(winner);
  let injected = false;
  const db = sqlDatabaseWithBatch(base, async statements => {
    if (!injected) {
      injected = true;
      await base.prepare(
        `INSERT INTO responses_state_items
          (id, api_key_id, state_epoch, payload_json, content_hash, payload_hash, payload_file_key, refreshed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(winner.id, winner.apiKeyId, winner.stateEpoch, winnerPayload, winner.contentHash, winner.payloadHash, null, winner.refreshedAt).run();
    }
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  });
  const repo = new SqlRepo(db);

  await expect(repo.responsesItems.insertMany([contender], 0))
    .rejects.toThrow(`Responses item id collision: ${contender.id}`);
  expect(await files.listKeys('responses-items/')).toEqual([]);
  expect(await repo.responsesItems.lookupMany('key-a', TEST_RESPONSES_STATE_EPOCH, [winner.id])).toEqual([winner]);
});

test('SQL conflict cleanup cannot delete a later winner\'s independently owned spill', async () => {
  const files = new DeleteHookFileProvider();
  initFileProvider(files);
  const base = await createSqliteTestDb();
  const item = spilledItem('msg_insert_owner_race', 'key-a', 1_000);
  const winnerPrepared = await prepareStoredResponsesPayload(item.id, item.apiKeyId, item.stateEpoch, item.payload);
  if (winnerPrepared.file === null) throw new Error('expected spilled winner');
  const winnerPayload = winnerPrepared.payloadJson;
  const winnerFileKey = winnerPrepared.file.key;
  await files.put(winnerFileKey, winnerPrepared.file.body);
  await base.prepare('INSERT INTO responses_state_payload_gc (file_key, eligible_at) VALUES (?, ?)')
    .bind(winnerFileKey, item.refreshedAt)
    .run();
  const insertWinner = base.prepare(
    `INSERT INTO responses_state_items
      (id, api_key_id, state_epoch, payload_json, content_hash, payload_hash, payload_file_key, refreshed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const db = sqlDatabaseWithBatch(base, async statements => {
    await insertWinner
      .bind(item.id, item.apiKeyId, item.stateEpoch, winnerPayload, item.contentHash, item.payloadHash, winnerFileKey, item.refreshedAt)
      .run();
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    await base.prepare('DELETE FROM responses_state_items WHERE id = ? AND api_key_id = ? AND state_epoch = ?')
      .bind(item.id, item.apiKeyId, item.stateEpoch)
      .run();
    return results;
  });
  files.beforeDelete = async loserFileKeys => {
    expect(loserFileKeys).not.toContain(winnerFileKey);
    await insertWinner
      .bind(item.id, item.apiKeyId, item.stateEpoch, winnerPayload, item.contentHash, item.payloadHash, winnerFileKey, item.refreshedAt)
      .run();
  };
  const repo = new SqlRepo(db);

  await expect(repo.responsesItems.insertMany([item], 0))
    .rejects.toThrow(`Responses item conflict disappeared before spill cleanup: ${item.id}`);

  expect(await files.listKeys('responses-items/')).toEqual([winnerFileKey]);
  expect((await repo.responsesItems.lookupMany(item.apiKeyId, TEST_RESPONSES_STATE_EPOCH, [item.id]))[0].payload).toEqual(item.payload);
});

test('SQL retention shrink preserves only the new window and growth cannot resurrect excluded rows', async () => {
  const now = Date.UTC(2026, 6, 22, 12);
  vi.useFakeTimers();
  vi.setSystemTime(now);
  try {
    const files = new MemoryFileProvider();
    initFileProvider(files);
    const repo = new SqlRepo(await createSqliteTestDb());
    initRepo(repo);
    const key = testApiKey('key-a');
    await repo.apiKeys.save(key);
    const sixDays = storedItem('msg_6d', key.id, 'six-days', now - 6 * 86400_000);
    const eightDays = storedItem('msg_8d', key.id, 'eight-days', now - 8 * 86400_000);
    await repo.responsesItems.insertMany([sixDays, eightDays], now - 30 * 86400_000);
    await repo.responsesSnapshots.insert({ id: 'resp_6d', apiKeyId: key.id, stateEpoch: key.responsesStateEpoch, itemIds: [sixDays.id], refreshedAt: sixDays.refreshedAt });
    await repo.responsesSnapshots.insert({ id: 'resp_8d', apiKeyId: key.id, stateEpoch: key.responsesStateEpoch, itemIds: [eightDays.id], refreshedAt: eightDays.refreshedAt });

    const shrunken = await repo.apiKeys.update(key.id, { responsesRetentionSeconds: 7 * 86400 });
    if (shrunken === null) throw new Error('key disappeared during shrink');
    expect(shrunken.responsesStateEpoch).toBe(key.responsesStateEpoch);
    const cutoff = shrunken.responsesStateVisibleAfter;
    expect(await repo.responsesItems.lookupActiveMany(key.id, key.responsesStateEpoch, [sixDays.id, eightDays.id], cutoff)).toEqual([sixDays]);
    expect(await repo.responsesSnapshots.lookupActive(key.id, key.responsesStateEpoch, 'resp_8d', cutoff)).toBeNull();
    await expect(repo.responsesItems.refreshMany([eightDays], now))
      .rejects.toThrow('Responses item disappeared or changed before lifetime refresh');

    const grown = await repo.apiKeys.update(key.id, { responsesRetentionSeconds: 30 * 86400 });
    if (grown === null) throw new Error('key disappeared during growth');
    expect(grown.responsesStateVisibleAfter).toBe(cutoff);
    expect(await repo.responsesItems.lookupActiveMany(key.id, key.responsesStateEpoch, [sixDays.id, eightDays.id], grown.responsesStateVisibleAfter)).toEqual([sixDays]);

    await sweepResponsesState(now);
    expect(await repo.responsesItems.lookupMany(key.id, key.responsesStateEpoch, [sixDays.id, eightDays.id])).toEqual([sixDays]);
    expect(await repo.responsesSnapshots.lookup(key.id, key.responsesStateEpoch, 'resp_6d')).not.toBeNull();
    expect(await repo.responsesSnapshots.lookup(key.id, key.responsesStateEpoch, 'resp_8d')).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

test('SQL disable rotates the epoch and a late old-epoch write is queued for bounded reclamation', async () => {
  const now = Date.UTC(2026, 6, 22, 12);
  vi.useFakeTimers();
  vi.setSystemTime(now);
  try {
    initFileProvider(new MemoryFileProvider());
    const repo = new SqlRepo(await createSqliteTestDb());
    initRepo(repo);
    const key = testApiKey('key-a');
    await repo.apiKeys.save(key);
    const disabled = await repo.apiKeys.update(key.id, { responsesRetentionSeconds: 0 });
    if (disabled === null) throw new Error('key disappeared during disable');
    expect(disabled.responsesStateEpoch).not.toBe(key.responsesStateEpoch);

    const late = storedItem('msg_late', key.id, 'late', now);
    await repo.responsesItems.insertMany([late], now - 30 * 86400_000);
    await repo.responsesSnapshots.insert({ id: 'resp_late', apiKeyId: key.id, stateEpoch: key.responsesStateEpoch, itemIds: [late.id], refreshedAt: now });
    expect(await repo.responsesItems.lookupMany(key.id, disabled.responsesStateEpoch, [late.id])).toEqual([]);

    await sweepResponsesState(now);
    expect(await repo.responsesItems.lookupMany(key.id, key.responsesStateEpoch, [late.id])).toEqual([]);
    expect(await repo.responsesSnapshots.lookup(key.id, key.responsesStateEpoch, 'resp_late')).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

test('migration 0065 invalidates all prior Responses state and installs the exact-item schema', async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  try {
    for (const [filename, sql] of migrationSqlByFilename) {
      if (filename === '0065_responses_producer_item_ids.sql') break;
      db.run(sql);
    }
    db.run('INSERT INTO responses_items VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ['msg_old', 'key-a', 'provider-a', 'msg_raw', 'message', '{}', 'hash', 1_000]);
    db.run(
      `INSERT INTO responses_snapshots
        (id, api_key_id, item_ids_json, created_at)
       VALUES (?, ?, ?, ?)`,
      ['resp_old', 'key-a', '["msg_old"]', 1_000],
    );

    const migration = migrationSqlByFilename.find(([filename]) => filename === '0065_responses_producer_item_ids.sql');
    if (migration === undefined) throw new Error('missing migration 0065_responses_producer_item_ids.sql');
    db.run(migration[1]);

    expect(db.exec('SELECT * FROM responses_items')[0]?.values ?? []).toEqual([]);
    expect(db.exec('SELECT * FROM responses_snapshots')[0]?.values ?? []).toEqual([]);
    expect(db.exec('PRAGMA table_info(responses_items)')[0]?.values.map(row => row[1])).toEqual([
      'id',
      'api_key_id',
      'payload_json',
      'content_hash',
      'created_at',
    ]);
  } finally {
    db.close();
  }
});

test('migration 0066 cuts over to empty retention tables without dropping populated prior state', async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  try {
    for (const [filename, sql] of migrationSqlByFilename) {
      if (filename === '0066_api_key_responses_retention.sql') break;
      db.run(sql);
    }
    db.run(
      `INSERT INTO api_keys
        (id, user_id, name, key, server_secret, created_at, last_used_at, upstream_ids, deleted_at, dump_retention_seconds)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['key-retention', 1, 'Retention', 'raw-retention', '11'.repeat(32), '2026-01-01T00:00:00Z', null, null, null, null],
    );
    db.run(
      `INSERT INTO responses_items
        (id, api_key_id, payload_json, content_hash, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      ['msg_populated', 'key-retention', '{}', 'hash', 1_000],
    );

    const migration = migrationSqlByFilename.find(([filename]) => filename === '0066_api_key_responses_retention.sql');
    if (migration === undefined) throw new Error('missing migration 0066_api_key_responses_retention.sql');
    db.run(migration[1]);

    expect(db.exec('SELECT id FROM responses_items')[0].values).toEqual([['msg_populated']]);
    expect(db.exec('SELECT * FROM responses_state_items')[0]?.values ?? []).toEqual([]);
    expect(db.exec('SELECT * FROM responses_state_snapshots')[0]?.values ?? []).toEqual([]);
    const [retention, epoch] = db.exec(
      "SELECT responses_retention_seconds, responses_state_epoch FROM api_keys WHERE id = 'key-retention'",
    )[0].values[0] as [number, string];
    expect(retention).toBe(0);
    expect(epoch).toMatch(/^[0-9a-f]{32}$/u);
  } finally {
    db.close();
  }
});
