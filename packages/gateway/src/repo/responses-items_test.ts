import initSqlJs from 'sql.js';
import { describe, expect, test, vi } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { serializeStoredResponsesPayload } from './responses-payload.ts';
import { SqlRepo } from './sql.ts';
import { createSqliteTestDb, migrationSqlByFilename } from './test-sqlite.ts';
import type { Repo, StoredResponsesItem } from './types.ts';
import { initFileProvider, MemoryFileProvider, type SqlDatabase, type SqlPreparedStatement } from '@floway-dev/platform';

const factories: Array<[string, () => Promise<Repo>]> = [
  ['memory', async () => new InMemoryRepo()],
  ['sql', async () => new SqlRepo(await createSqliteTestDb())],
];

const storedItem = (id: string, apiKeyId: string, contentHash: string | null, createdAt: number): StoredResponsesItem => ({
  id,
  apiKeyId,
  upstreamId: null,
  upstreamItemId: null,
  itemType: 'message',
  payload: { item: { type: 'message', id, role: 'assistant', content: [] } },
  contentHash,
  createdAt,
});

const spilledItem = (id: string, apiKeyId: string, createdAt: number): StoredResponsesItem => {
  const bytes = new Uint8Array(128 * 1024);
  crypto.getRandomValues(bytes.subarray(0, 64 * 1024));
  crypto.getRandomValues(bytes.subarray(64 * 1024));
  let content = '';
  for (const byte of bytes) content += byte.toString(16).padStart(2, '0');
  return {
    ...storedItem(id, apiKeyId, `${id}-hash`, createdAt),
    payload: { item: { type: 'message', id, role: 'assistant', content } },
  };
};

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

describe.each(factories)('%s Responses state repo', (_name, createRepo) => {
  test('stores complete key-scoped items and looks them up by id and content hash', async () => {
    initFileProvider(new MemoryFileProvider());
    const repo = await createRepo();
    const first = storedItem('msg_first', 'key-a', 'hash-a', 1_000);
    const second = storedItem('msg_second', 'key-a', 'hash-b', 2_000);
    const other = storedItem('msg_other', 'key-b', 'hash-a', 3_000);
    const unhashed = storedItem('msg_unhashed', 'key-a', null, 4_000);

    await repo.responsesItems.insertMany([first, second, other, unhashed]);

    expect(await repo.responsesItems.lookupMany('key-a', [second.id, unhashed.id, first.id])).toEqual([second, unhashed, first]);
    expect(await repo.responsesItems.lookupMany('key-b', [first.id])).toEqual([]);
    expect(await repo.responsesItems.lookupManyByContentHash('key-a', ['hash-a'])).toEqual([first]);
  });

  test('deletes complete items and snapshots by their refreshable retention timestamp', async () => {
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

  test('rejects a lifetime refresh after its item disappeared', async () => {
    initFileProvider(new MemoryFileProvider());
    const repo = await createRepo();
    const item = storedItem('msg_missing', 'key-a', 'missing', 1_000);
    await repo.responsesItems.insertMany([item]);
    await repo.responsesItems.deleteOlderThan(2_000);

    await expect(repo.responsesItems.refreshMany([item], 3_000))
      .rejects.toThrow('Responses item disappeared before lifetime refresh: msg_missing');
  });

  test('snapshot upsert refreshes its timestamp and item graph', async () => {
    initFileProvider(new MemoryFileProvider());
    const repo = await createRepo();
    await repo.responsesSnapshots.insert({ id: 'resp_same', apiKeyId: 'key-a', itemIds: ['msg_old'], createdAt: 1_000 });
    await repo.responsesSnapshots.insert({ id: 'resp_same', apiKeyId: 'key-a', itemIds: ['msg_new'], createdAt: 3_000 });
    await repo.responsesSnapshots.insert({ id: 'resp_same', apiKeyId: 'key-a', itemIds: ['msg_stale'], createdAt: 2_000 });

    expect(await repo.responsesSnapshots.lookup('key-a', 'resp_same')).toEqual({
      id: 'resp_same', apiKeyId: 'key-a', itemIds: ['msg_new'], createdAt: 3_000,
    });
  });

  test('item refresh never lowers an existing lifetime', async () => {
    initFileProvider(new MemoryFileProvider());
    const repo = await createRepo();
    const item = storedItem('msg_monotonic', 'key-a', 'monotonic', 1_000);
    await repo.responsesItems.insertMany([item]);
    await repo.responsesItems.refreshMany([item], 3_000);
    await repo.responsesItems.refreshMany([item], 2_000);

    expect((await repo.responsesItems.lookupMany('key-a', [item.id]))[0].createdAt).toBe(3_000);
  });

  test('refreshes spilled payload expiry without retaining the previous file', async () => {
    const files = new MemoryFileProvider();
    initFileProvider(files);
    const repo = await createRepo();
    const item = spilledItem('msg_large', 'key-a', 1_000);
    await repo.responsesItems.insertMany([item]);
    const before = await files.listKeys('responses-items/');
    const put = vi.spyOn(files, 'put');
    await repo.responsesItems.refreshMany([item], 1_000 + 10 * 60 * 1000);
    if (_name === 'sql') expect(put).not.toHaveBeenCalled();
    await repo.responsesItems.refreshMany([item], 1_000 + 2 * 60 * 60 * 1000);
    const after = await files.listKeys('responses-items/');
    await repo.responsesItems.refreshMany([item], 1_000 + 60 * 60 * 1000);
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
    expect((await repo.responsesItems.lookupMany('key-a', [item.id]))[0].createdAt).toBe(1_000 + 2 * 60 * 60 * 1000);
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
        await base.prepare('DELETE FROM responses_items WHERE id = ? AND api_key_id = ?')
          .bind('msg_race', 'key-a')
          .run();
      }
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  };
  const repo = new SqlRepo(db);
  const item = spilledItem('msg_race', 'key-a', 1_000);
  await repo.responsesItems.insertMany([item]);
  const originalFiles = await files.listKeys('responses-items/');
  expect(originalFiles).toHaveLength(1);

  deleteBeforeBatch = true;
  await expect(repo.responsesItems.refreshMany([item], 1_000 + 2 * 60 * 60 * 1000))
    .rejects.toThrow('Responses item disappeared before lifetime refresh: msg_race');

  expect(await files.listKeys('responses-items/')).toEqual(originalFiles);
  expect(await repo.responsesItems.lookupMany('key-a', [item.id])).toEqual([]);
});

test('SQL stale refresh accepts a newer concurrent spill descriptor', async () => {
  const files = new MemoryFileProvider();
  initFileProvider(files);
  const base = await createSqliteTestDb();
  const item = spilledItem('msg_refresh_cas', 'key-a', 1_000);
  await new SqlRepo(base).responsesItems.insertMany([item]);
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
  const staleCreatedAt = 1_000 + 10 * 60 * 1000;
  const currentCreatedAt = 1_000 + 2 * 60 * 60 * 1000;

  const staleRefresh = repo.responsesItems.refreshMany([item], staleCreatedAt);
  await staleStarted.promise;
  await repo.responsesItems.refreshMany([item], currentCreatedAt);
  staleGate.resolve();
  await staleRefresh;

  const [persisted] = await repo.responsesItems.lookupMany('key-a', [item.id]);
  expect(persisted.createdAt).toBe(currentCreatedAt);
  expect(persisted.payload).toEqual(item.payload);
  expect(await files.listKeys('responses-items/')).toHaveLength(1);
});

test('SQL newer refresh retries after an older concurrent spill wins CAS', async () => {
  const files = new MemoryFileProvider();
  initFileProvider(files);
  const base = await createSqliteTestDb();
  const item = spilledItem('msg_refresh_retry', 'key-a', 1_000);
  await new SqlRepo(base).responsesItems.insertMany([item]);
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
  const olderCreatedAt = 1_000 + 60 * 60 * 1000;
  const newerCreatedAt = 1_000 + 2 * 60 * 60 * 1000;

  const newerRefresh = repo.responsesItems.refreshMany([item], newerCreatedAt);
  await newerStarted.promise;
  await repo.responsesItems.refreshMany([item], olderCreatedAt);
  newerGate.resolve();
  await newerRefresh;

  const [persisted] = await repo.responsesItems.lookupMany('key-a', [item.id]);
  expect(persisted.createdAt).toBe(newerCreatedAt);
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
  const items = Array.from({ length: 240 }, (_, index) =>
    storedItem(`msg_bulk_${index}`, 'key-a', `hash-${index}`, 1_000));

  await repo.responsesItems.insertMany(items);
  await repo.responsesItems.refreshMany(items, 2_000);

  expect(batchSizes).toEqual([20, 10]);
  expect(maxBindCount).toBeLessThanOrEqual(100);
  expect(await repo.responsesItems.lookupMany('key-a', items.map(item => item.id))).toHaveLength(items.length);
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

  await expect(repo.responsesItems.insertMany([spilledItem('msg_before_circular', 'key-a', 1_000), invalid]))
    .rejects.toThrow();

  expect(await files.listKeys('responses-items/')).toEqual([]);
});

test('SQL insert cleans generated spills when its batch fails', async () => {
  const files = new MemoryFileProvider();
  initFileProvider(files);
  const base = await createSqliteTestDb();
  const batchFailure = new Error('simulated insert batch failure');
  const repo = new SqlRepo(sqlDatabaseWithBatch(base, () => Promise.reject(batchFailure)));

  await expect(repo.responsesItems.insertMany([spilledItem('msg_insert_failure', 'key-a', 1_000)]))
    .rejects.toBe(batchFailure);

  expect(await files.listKeys('responses-items/')).toEqual([]);
});

test('SQL refresh cleans earlier replacement spills when a later payload cannot be serialized', async () => {
  const files = new MemoryFileProvider();
  initFileProvider(files);
  const base = await createSqliteTestDb();
  const repo = new SqlRepo(base);
  const first = spilledItem('msg_refresh_before_circular', 'key-a', 1_000);
  const second = spilledItem('msg_refresh_circular', 'key-a', 1_000);
  await repo.responsesItems.insertMany([first, second]);
  const originalFiles = await files.listKeys('responses-items/');
  const circular: Record<string, unknown> = { type: 'message', id: second.id };
  circular.self = circular;

  await expect(repo.responsesItems.refreshMany([
    first,
    { ...second, payload: { item: circular } },
  ], 1_000 + 2 * 60 * 60 * 1000)).rejects.toThrow();

  expect((await files.listKeys('responses-items/')).toSorted()).toEqual(originalFiles.toSorted());
});

test('SQL refresh cleans replacement spills and keeps originals when its batch fails', async () => {
  const files = new MemoryFileProvider();
  initFileProvider(files);
  const base = await createSqliteTestDb();
  const originalRepo = new SqlRepo(base);
  const item = spilledItem('msg_refresh_failure', 'key-a', 1_000);
  await originalRepo.responsesItems.insertMany([item]);
  const originalFiles = await files.listKeys('responses-items/');
  const batchFailure = new Error('simulated refresh batch failure');
  const repo = new SqlRepo(sqlDatabaseWithBatch(base, () => Promise.reject(batchFailure)));

  await expect(repo.responsesItems.refreshMany([item], 1_000 + 2 * 60 * 60 * 1000))
    .rejects.toBe(batchFailure);

  expect(await files.listKeys('responses-items/')).toEqual(originalFiles);
});

test('SQL duplicate insert does not write an unreferenced replacement spill', async () => {
  const files = new MemoryFileProvider();
  initFileProvider(files);
  const repo = new SqlRepo(await createSqliteTestDb());
  const original = spilledItem('msg_duplicate', 'key-a', 1_000);
  await repo.responsesItems.insertMany([original]);
  const originalFiles = await files.listKeys('responses-items/');
  expect(originalFiles).toHaveLength(1);

  const put = vi.spyOn(files, 'put');
  await repo.responsesItems.insertMany([{ ...original, createdAt: 1_000 + 2 * 60 * 60 * 1000 }]);

  expect(put).not.toHaveBeenCalled();
  expect(await files.listKeys('responses-items/')).toEqual(originalFiles);
  expect(await repo.responsesItems.lookupMany('key-a', [original.id])).toEqual([original]);
});

test('SQL insert conflict cleans its spill when the winning row disappears', async () => {
  const files = new MemoryFileProvider();
  initFileProvider(files);
  const base = await createSqliteTestDb();
  const inlinePayload = await serializeStoredResponsesPayload(
    'msg_insert_race',
    'key-a',
    1_000,
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
        'INSERT INTO responses_items (id, api_key_id, item_type, payload_json, content_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      );
      await insertWinner.bind('msg_insert_race', 'key-a', 'message', inlinePayload, 'race', 1_000).run();
      await insertWinner.bind('msg_insert_survivor', 'key-a', 'message', inlinePayload, 'survivor', 1_000).run();
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      await base.prepare('DELETE FROM responses_items WHERE id = ? AND api_key_id = ?')
        .bind('msg_insert_race', 'key-a')
        .run();
      return results;
    },
  };
  const repo = new SqlRepo(db);
  const item = spilledItem('msg_insert_race', 'key-a', 1_000 + 2 * 60 * 60 * 1000);
  const survivor = spilledItem('msg_insert_survivor', 'key-a', 1_000 + 2 * 60 * 60 * 1000);

  await expect(repo.responsesItems.insertMany([item, survivor]))
    .rejects.toThrow('Responses item conflict disappeared before spill cleanup: msg_insert_race');
  expect(await files.listKeys('responses-items/')).toEqual([]);
});

test('SQL conflict cleanup cannot delete a later winner\'s independently owned spill', async () => {
  const files = new DeleteHookFileProvider();
  initFileProvider(files);
  const base = await createSqliteTestDb();
  const item = spilledItem('msg_insert_owner_race', 'key-a', 1_000);
  const winnerPayload = await serializeStoredResponsesPayload(
    item.id,
    item.apiKeyId,
    item.createdAt,
    item.payload,
  );
  const winnerFileKey = (JSON.parse(winnerPayload) as { key: string }).key;
  const insertWinner = base.prepare(
    'INSERT INTO responses_items (id, api_key_id, item_type, payload_json, content_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const db = sqlDatabaseWithBatch(base, async statements => {
    await insertWinner
      .bind(item.id, item.apiKeyId, item.itemType, winnerPayload, item.contentHash, item.createdAt)
      .run();
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    await base.prepare('DELETE FROM responses_items WHERE id = ? AND api_key_id = ?')
      .bind(item.id, item.apiKeyId)
      .run();
    return results;
  });
  files.beforeDelete = async loserFileKey => {
    expect(loserFileKey).not.toBe(winnerFileKey);
    await insertWinner
      .bind(item.id, item.apiKeyId, item.itemType, winnerPayload, item.contentHash, item.createdAt)
      .run();
  };
  const repo = new SqlRepo(db);

  await expect(repo.responsesItems.insertMany([item]))
    .rejects.toThrow(`Responses item conflict disappeared before spill cleanup: ${item.id}`);

  expect(await files.listKeys('responses-items/')).toEqual([winnerFileKey]);
  expect((await repo.responsesItems.lookupMany(item.apiKeyId, [item.id]))[0].payload).toEqual(item.payload);
});

test('migration 0058 replaces legacy Responses state with the full-state schema', async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  try {
    for (const [filename, sql] of migrationSqlByFilename) {
      if (filename === '0058_responses_full_state.sql') break;
      db.run(sql);
    }

    const descriptor = JSON.stringify({ version: 1, storage: 'inline', encoding: 'gzip', payload: 'H4sIAAAAAAAA' });
    const insertItem = `INSERT INTO responses_items
      (id, api_key_id, upstream_id, upstream_item_id, item_type, payload_json, content_hash, created_at, refreshed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    db.run(insertItem, ['msg_old', 'key-a', 'upstream-a', 'msg_upstream', 'message', descriptor, 'hash-a', 1_000, 9_000]);
    db.run(`INSERT INTO responses_snapshots
      (id, api_key_id, item_ids_json, created_at, refreshed_at)
      VALUES (?, ?, ?, ?, ?)`, ['resp_old', 'key-a', '["msg_old"]', 1_000, 9_000]);

    const migration = migrationSqlByFilename.find(([filename]) => filename === '0058_responses_full_state.sql');
    if (migration === undefined) throw new Error('missing migration 0058_responses_full_state.sql');
    db.run(migration[1]);

    expect(db.exec('SELECT * FROM responses_items')[0]?.values ?? []).toEqual([]);
    expect(db.exec('SELECT * FROM responses_snapshots')[0]?.values ?? []).toEqual([]);
    const columns = db.exec('PRAGMA table_info(responses_items)')[0]?.values.map(row => row[1]);
    expect(columns).not.toContain('upstream_id');
    expect(columns).not.toContain('upstream_item_id');
  } finally {
    db.close();
  }
});

test('migration 0059 drops every prior Responses table and creates item-origin storage', async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  try {
    for (const [filename, sql] of migrationSqlByFilename) {
      if (filename === '0059_responses_item_origins.sql') break;
      db.run(sql);
    }
    db.run(
      `INSERT INTO responses_items
        (id, api_key_id, item_type, payload_json, content_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['msg_current', 'key-a', 'message', '{}', 'hash', 1_000],
    );
    db.run(
      `INSERT INTO responses_snapshots
        (id, api_key_id, item_ids_json, created_at)
       VALUES (?, ?, ?, ?)`,
      ['resp_current', 'key-a', '["msg_current"]', 1_000],
    );

    const migration = migrationSqlByFilename.find(([filename]) => filename === '0059_responses_item_origins.sql');
    if (migration === undefined) throw new Error('missing migration 0059_responses_item_origins.sql');
    db.run(migration[1]);

    expect(db.exec('SELECT * FROM responses_items')[0]?.values ?? []).toEqual([]);
    expect(db.exec('SELECT * FROM responses_snapshots')[0]?.values ?? []).toEqual([]);
    expect(db.exec('PRAGMA table_info(responses_items)')[0]?.values.map(row => row[1])).toEqual([
      'id',
      'api_key_id',
      'upstream_id',
      'upstream_item_id',
      'item_type',
      'payload_json',
      'content_hash',
      'created_at',
    ]);
    expect(db.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'responses_%' ORDER BY name")[0]?.values).toEqual([
      ['responses_items'],
      ['responses_snapshots'],
    ]);
  } finally {
    db.close();
  }
});
