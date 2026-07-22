import initSqlJs from 'sql.js';
import { describe, expect, test, vi } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { responsesItemPayloadExpiryBucketPrefix, serializeStoredResponsesPayload } from './responses-payload.ts';
import { SqlRepo } from './sql.ts';
import { createSqliteTestDb, migrationSqlByFilename } from './test-sqlite.ts';
import type { Repo, StoredResponsesItem } from './types.ts';
import { testResponsesStateLifetime, TEST_RESPONSES_RETENTION_SECONDS, TEST_RESPONSES_STATE_EPOCH } from '../test-helpers/responses-state.ts';
import { initFileProvider, MemoryFileProvider, type SqlDatabase, type SqlPreparedStatement } from '@floway-dev/platform';

const factories: Array<[string, () => Promise<Repo>]> = [
  ['memory', async () => new InMemoryRepo()],
  ['sql', async () => new SqlRepo(await createSqliteTestDb())],
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
    payloadHash: JSON.stringify(payload),
    payloadFileKey: 'spilled',
  };
};

const expiresAt = (refreshedAt: number): number =>
  refreshedAt + TEST_RESPONSES_RETENTION_SECONDS * 1000;

const sqlDatabaseWithBatch = (
  base: SqlDatabase,
  runBatch: (statements: SqlPreparedStatement[]) => Promise<Awaited<ReturnType<NonNullable<SqlDatabase['batch']>>>>,
): SqlDatabase => ({
  prepare: query => base.prepare(query),
  exec: sql => base.exec(sql),
  batch: runBatch,
});

class DeleteHookFileProvider extends MemoryFileProvider {
  beforeDelete: ((key: string) => Promise<void>) | undefined;

  override async deletePrefix(prefix: string): Promise<void> {
    const beforeDelete = this.beforeDelete;
    this.beforeDelete = undefined;
    await beforeDelete?.(prefix);
    await super.deletePrefix(prefix);
  }
}

class GetHookFileProvider extends MemoryFileProvider {
  beforeGet: ((key: string) => Promise<void>) | undefined;

  override async get(key: string): Promise<Uint8Array | null> {
    await this.beforeGet?.(key);
    return await super.get(key);
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

    expect((await repo.responsesItems.deleteExpiredHour(expiresAt(1_000), expiresAt(2_000), 100)).deleted).toBe(1);
    expect(await repo.responsesSnapshots.deleteExpiredHour(expiresAt(1_000), expiresAt(2_000), 100)).toBe(1);
    expect(await repo.responsesItems.lookupMany('key-a', TEST_RESPONSES_STATE_EPOCH, [old.id, fresh.id])).toEqual([fresh]);
    expect(await repo.responsesSnapshots.lookup('key-a', TEST_RESPONSES_STATE_EPOCH, 'resp_old')).toBeNull();
    expect(await repo.responsesSnapshots.lookup('key-a', TEST_RESPONSES_STATE_EPOCH, 'resp_fresh')).toEqual({
      id: 'resp_fresh', apiKeyId: 'key-a', stateEpoch: TEST_RESPONSES_STATE_EPOCH, itemIds: [fresh.id], ...testResponsesStateLifetime(3_000),
    });
  });

  test('a key-only lifetime refresh is a no-op after its item expired', async () => {
    initFileProvider(new MemoryFileProvider());
    const repo = await createRepo();
    const item = storedItem('msg_missing', 'key-a', 'missing', 1_000);
    await repo.responsesItems.insertMany([item], 0);
    await repo.responsesItems.deleteExpiredHour(expiresAt(1_000), expiresAt(2_000), 100);

    await expect(repo.responsesItems.refreshMany([item], 3_000, expiresAt(3_000))).resolves.toBeUndefined();
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
    await repo.responsesItems.refreshMany([item], 3_000, expiresAt(3_000));
    await repo.responsesItems.refreshMany([item], 2_000, expiresAt(2_000));

    expect((await repo.responsesItems.lookupMany('key-a', TEST_RESPONSES_STATE_EPOCH, [item.id]))[0].refreshedAt).toBe(3_000);
  });

  test('refreshes spilled payload expiry without retaining the previous file', async () => {
    const files = new MemoryFileProvider();
    initFileProvider(files);
    const repo = await createRepo();
    const item = spilledItem('msg_large', 'key-a', 1_000);
    await repo.responsesItems.insertMany([item], 0);
    const before = await files.listKeys('responses-items/');
    const put = vi.spyOn(files, 'put');
    await repo.responsesItems.refreshMany([item], 1_000 + 10 * 60 * 1000, expiresAt(1_000 + 10 * 60 * 1000));
    if (_name === 'sql') expect(put).not.toHaveBeenCalled();
    await repo.responsesItems.refreshMany([item], 1_000 + 2 * 60 * 60 * 1000, expiresAt(1_000 + 2 * 60 * 60 * 1000));
    const after = await files.listKeys('responses-items/');
    await repo.responsesItems.refreshMany([item], 1_000 + 60 * 60 * 1000, expiresAt(1_000 + 60 * 60 * 1000));
    const afterOlderRefresh = await files.listKeys('responses-items/');

    if (_name === 'sql') {
      expect(before).toHaveLength(1);
      expect(after).toHaveLength(1);
      expect(after[0]).not.toBe(before[0]);
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
  const db: SqlDatabase = {
    prepare: query => base.prepare(query),
    exec: sql => base.exec(sql),
    batch: async statements => {
      if (deleteBeforeBatch) {
        deleteBeforeBatch = false;
        await base.prepare('DELETE FROM responses_state_items WHERE id = ? AND api_key_id = ? AND state_epoch = ?')
          .bind('msg_race', 'key-a', TEST_RESPONSES_STATE_EPOCH)
          .run();
      }
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  };
  const repo = new SqlRepo(db);
  const item = spilledItem('msg_race', 'key-a', 1_000);
  await repo.responsesItems.insertMany([item], 0);
  const originalFiles = await files.listKeys('responses-items/');
  expect(originalFiles).toHaveLength(1);

  deleteBeforeBatch = true;
  await expect(repo.responsesItems.refreshMany(
    [item],
    1_000 + 2 * 60 * 60 * 1000,
    expiresAt(1_000 + 2 * 60 * 60 * 1000),
  )).rejects.toThrow('Responses item disappeared before lifetime refresh: msg_race');

  expect(await files.listKeys('responses-items/')).toEqual([]);
  expect(await repo.responsesItems.lookupMany('key-a', TEST_RESPONSES_STATE_EPOCH, [item.id])).toEqual([]);
});

test('SQL stale refresh accepts a newer concurrent spill descriptor', async () => {
  const files = new MemoryFileProvider();
  initFileProvider(files);
  const base = await createSqliteTestDb();
  const item = spilledItem('msg_refresh_cas', 'key-a', 1_000);
  await new SqlRepo(base).responsesItems.insertMany([item], 0);
  const staleGate = Promise.withResolvers<void>();
  const staleStarted = Promise.withResolvers<void>();
  let batchNumber = 0;
  const repo = new SqlRepo(sqlDatabaseWithBatch(base, async statements => {
    batchNumber += 1;
    if (batchNumber === 1) {
      staleStarted.resolve();
      await staleGate.promise;
    }
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }));
  const staleRefreshedAt = 1_000 + 10 * 60 * 1000;
  const currentRefreshedAt = 1_000 + 2 * 60 * 60 * 1000;

  const staleRefresh = repo.responsesItems.refreshMany([item], staleRefreshedAt, expiresAt(staleRefreshedAt));
  await staleStarted.promise;
  await repo.responsesItems.refreshMany([item], currentRefreshedAt, expiresAt(currentRefreshedAt));
  staleGate.resolve();
  await staleRefresh;

  const [persisted] = await repo.responsesItems.lookupMany('key-a', TEST_RESPONSES_STATE_EPOCH, [item.id]);
  expect(persisted.refreshedAt).toBe(currentRefreshedAt);
  expect(persisted.payload).toEqual(item.payload);
  expect(await files.listKeys('responses-items/')).toHaveLength(1);
});

test('SQL newer refresh retries after an older concurrent spill wins CAS', async () => {
  const files = new MemoryFileProvider();
  initFileProvider(files);
  const base = await createSqliteTestDb();
  const item = spilledItem('msg_refresh_retry', 'key-a', 1_000);
  await new SqlRepo(base).responsesItems.insertMany([item], 0);
  const newerGate = Promise.withResolvers<void>();
  const newerStarted = Promise.withResolvers<void>();
  let batchNumber = 0;
  const repo = new SqlRepo(sqlDatabaseWithBatch(base, async statements => {
    batchNumber += 1;
    if (batchNumber === 1) {
      newerStarted.resolve();
      await newerGate.promise;
    }
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }));
  const olderRefreshedAt = 1_000 + 60 * 60 * 1000;
  const newerRefreshedAt = 1_000 + 2 * 60 * 60 * 1000;

  const newerRefresh = repo.responsesItems.refreshMany([item], newerRefreshedAt, expiresAt(newerRefreshedAt));
  await newerStarted.promise;
  await repo.responsesItems.refreshMany([item], olderRefreshedAt, expiresAt(olderRefreshedAt));
  newerGate.resolve();
  await newerRefresh;

  const [persisted] = await repo.responsesItems.lookupMany('key-a', TEST_RESPONSES_STATE_EPOCH, [item.id]);
  expect(persisted.refreshedAt).toBe(newerRefreshedAt);
  expect(persisted.payload).toEqual(item.payload);
  expect(await files.listKeys('responses-items/')).toHaveLength(1);
});

test('SQL refresh rereads a spill moved by a concurrent refresh', async () => {
  const files = new GetHookFileProvider();
  initFileProvider(files);
  const repo = new SqlRepo(await createSqliteTestDb());
  const item = spilledItem('msg_refresh_reader_race', 'key-a', 1_000);
  await repo.responsesItems.insertMany([item], 0);
  const [originalKey] = await files.listKeys('responses-items/');
  const firstRefreshedAt = 1_000 + 2 * 60 * 60 * 1000;
  const secondRefreshedAt = 1_000 + 4 * 60 * 60 * 1000;
  let nestedRefresh: Promise<void> | undefined;
  files.beforeGet = async key => {
    if (key !== originalKey || nestedRefresh !== undefined) return;
    files.beforeGet = undefined;
    nestedRefresh = repo.responsesItems.refreshMany([item], secondRefreshedAt, expiresAt(secondRefreshedAt));
    await nestedRefresh;
  };

  await expect(repo.responsesItems.refreshMany([item], firstRefreshedAt, expiresAt(firstRefreshedAt))).resolves.toBeUndefined();
  await nestedRefresh;

  const [persisted] = await repo.responsesItems.lookupMany(item.apiKeyId, TEST_RESPONSES_STATE_EPOCH, [item.id]);
  expect(persisted.refreshedAt).toBe(secondRefreshedAt);
  expect(persisted.payload).toEqual(item.payload);
  const survivingFiles = await files.listKeys('responses-items/');
  expect(survivingFiles).toHaveLength(1);
  expect(survivingFiles[0].startsWith(
    responsesItemPayloadExpiryBucketPrefix(secondRefreshedAt + TEST_RESPONSES_RETENTION_SECONDS * 1000),
  )).toBe(true);
});

test('SQL lookup rereads a spill moved by a concurrent refresh', async () => {
  const files = new GetHookFileProvider();
  initFileProvider(files);
  const repo = new SqlRepo(await createSqliteTestDb());
  const item = spilledItem('msg_lookup_reader_race', 'key-a', 1_000);
  await repo.responsesItems.insertMany([item], 0);
  const [originalKey] = await files.listKeys('responses-items/');
  const refreshedRefreshedAt = 1_000 + 2 * 60 * 60 * 1000;
  let nestedRefresh: Promise<void> | undefined;
  files.beforeGet = async key => {
    if (key !== originalKey || nestedRefresh !== undefined) return;
    files.beforeGet = undefined;
    nestedRefresh = repo.responsesItems.refreshMany([item], refreshedRefreshedAt, expiresAt(refreshedRefreshedAt));
    await nestedRefresh;
  };

  const [persisted] = await repo.responsesItems.lookupMany(item.apiKeyId, TEST_RESPONSES_STATE_EPOCH, [item.id]);
  expect(persisted).toMatchObject({
    id: item.id,
    payload: item.payload,
    refreshedAt: refreshedRefreshedAt,
    expiresAt: expiresAt(refreshedRefreshedAt),
  });
  expect(persisted.payloadFileKey).not.toBe(item.payloadFileKey);
  await nestedRefresh;
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
  const items = Array.from({ length: 240 }, (_, index) =>
    storedItem(`msg_bulk_${index}`, 'key-a', `hash-${index}`, 1_000));

  await repo.responsesItems.insertMany(items, 0);
  await repo.responsesItems.refreshMany(items, 2_000, expiresAt(2_000));

  expect(batchSizes).toEqual([22, 3]);
  expect(maxBindCount).toBeLessThanOrEqual(100);
  expect(await repo.responsesItems.lookupMany('key-a', TEST_RESPONSES_STATE_EPOCH, items.map(item => item.id))).toHaveLength(items.length);
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

test('SQL refresh cleans replacement spills and keeps originals when its batch fails', async () => {
  const files = new MemoryFileProvider();
  initFileProvider(files);
  const base = await createSqliteTestDb();
  const originalRepo = new SqlRepo(base);
  const item = spilledItem('msg_refresh_failure', 'key-a', 1_000);
  await originalRepo.responsesItems.insertMany([item], 0);
  const originalFiles = await files.listKeys('responses-items/');
  const batchFailure = new Error('simulated refresh batch failure');
  const repo = new SqlRepo(sqlDatabaseWithBatch(base, () => Promise.reject(batchFailure)));

  await expect(repo.responsesItems.refreshMany(
    [item],
    1_000 + 2 * 60 * 60 * 1000,
    expiresAt(1_000 + 2 * 60 * 60 * 1000),
  ))
    .rejects.toBe(batchFailure);

  expect(await files.listKeys('responses-items/')).toEqual(originalFiles);
});

test('SQL exact duplicate refreshes its spill lifetime without leaving the old file', async () => {
  const files = new MemoryFileProvider();
  initFileProvider(files);
  const repo = new SqlRepo(await createSqliteTestDb());
  const original = spilledItem('msg_duplicate', 'key-a', 1_000);
  await repo.responsesItems.insertMany([original], 0);
  const originalFiles = await files.listKeys('responses-items/');
  expect(originalFiles).toHaveLength(1);

  const put = vi.spyOn(files, 'put');
  const refreshedAt = 1_000 + 2 * 60 * 60 * 1000;
  await repo.responsesItems.insertMany([{ ...original, refreshedAt, expiresAt: expiresAt(refreshedAt) }], 0);

  expect(put).toHaveBeenCalledTimes(1);
  const refreshedFiles = await files.listKeys('responses-items/');
  expect(refreshedFiles).toHaveLength(1);
  expect(refreshedFiles).not.toEqual(originalFiles);
  expect((await repo.responsesItems.lookupMany('key-a', TEST_RESPONSES_STATE_EPOCH, [original.id]))[0]).toMatchObject({
    id: original.id,
    payload: original.payload,
    contentHash: original.contentHash,
    payloadHash: original.payloadHash,
    refreshedAt,
    expiresAt: expiresAt(refreshedAt),
  });
});

test('SQL insert conflict cleans its spill when the winning row disappears', async () => {
  const files = new MemoryFileProvider();
  initFileProvider(files);
  const base = await createSqliteTestDb();
  const inlinePayload = await serializeStoredResponsesPayload(
    'msg_insert_race',
    'key-a',
    TEST_RESPONSES_STATE_EPOCH,
    expiresAt(1_000),
    { item: { type: 'message', id: 'msg_insert_race', role: 'assistant', content: [] } },
  );
  let injectConflict = true;
  const db: SqlDatabase = {
    prepare: query => base.prepare(query),
    exec: sql => base.exec(sql),
    batch: async statements => {
      if (!injectConflict) throw new Error('unexpected second insert batch');
      injectConflict = false;
      const insertWinner = base.prepare(
        `INSERT INTO responses_state_items
          (id, api_key_id, state_epoch, payload_json, content_hash, payload_hash, payload_file_key, refreshed_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      await insertWinner.bind('msg_insert_race', 'key-a', TEST_RESPONSES_STATE_EPOCH, inlinePayload, 'race', 'race-payload', null, 1_000, expiresAt(1_000)).run();
      await insertWinner.bind('msg_insert_survivor', 'key-a', TEST_RESPONSES_STATE_EPOCH, inlinePayload, 'survivor', 'survivor-payload', null, 1_000, expiresAt(1_000)).run();
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
  const winnerPayload = await serializeStoredResponsesPayload(winner.id, winner.apiKeyId, TEST_RESPONSES_STATE_EPOCH, winner.expiresAt, winner.payload);
  let injected = false;
  const db = sqlDatabaseWithBatch(base, async statements => {
    if (!injected) {
      injected = true;
      await base.prepare(
        `INSERT INTO responses_state_items
          (id, api_key_id, state_epoch, payload_json, content_hash, payload_hash, payload_file_key, refreshed_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(winner.id, winner.apiKeyId, winner.stateEpoch, winnerPayload, winner.contentHash, winner.payloadHash, null, winner.refreshedAt, winner.expiresAt).run();
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
  const winnerPayload = await serializeStoredResponsesPayload(
    item.id,
    item.apiKeyId,
    item.stateEpoch,
    item.expiresAt,
    item.payload,
  );
  const winnerFileKey = (JSON.parse(winnerPayload) as { key: string }).key;
  const insertWinner = base.prepare(
    `INSERT INTO responses_state_items
      (id, api_key_id, state_epoch, payload_json, content_hash, payload_hash, payload_file_key, refreshed_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const db = sqlDatabaseWithBatch(base, async statements => {
    await insertWinner
      .bind(item.id, item.apiKeyId, item.stateEpoch, winnerPayload, item.contentHash, item.payloadHash, winnerFileKey, item.refreshedAt, item.expiresAt)
      .run();
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    await base.prepare('DELETE FROM responses_state_items WHERE id = ? AND api_key_id = ? AND state_epoch = ?')
      .bind(item.id, item.apiKeyId, item.stateEpoch)
      .run();
    return results;
  });
  files.beforeDelete = async loserFileKey => {
    expect(loserFileKey).not.toBe(winnerFileKey);
    await insertWinner
      .bind(item.id, item.apiKeyId, item.stateEpoch, winnerPayload, item.contentHash, item.payloadHash, winnerFileKey, item.refreshedAt, item.expiresAt)
      .run();
  };
  const repo = new SqlRepo(db);

  await expect(repo.responsesItems.insertMany([item], 0))
    .rejects.toThrow(`Responses item conflict disappeared before spill cleanup: ${item.id}`);

  expect(await files.listKeys('responses-items/')).toEqual([winnerFileKey]);
  expect((await repo.responsesItems.lookupMany(item.apiKeyId, TEST_RESPONSES_STATE_EPOCH, [item.id]))[0].payload).toEqual(item.payload);
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
