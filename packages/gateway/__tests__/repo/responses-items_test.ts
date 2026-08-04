import { afterEach, describe, expect, test, vi } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { createSqliteTestDb, createSqlJsDatabase, migrationSqlByFilename } from './test-sqlite.ts';
import { initRepo } from '../../src/repo/index.ts';
import { hashResponsesJson } from '../../src/repo/responses-hash.ts';
import { prepareStoredResponsesPayload } from '../../src/repo/responses-payload.ts';
import { quantizeResponsesRefreshedAt, responsesStateCutoff } from '../../src/repo/responses-retention.ts';
import { SqlRepo } from '../../src/repo/sql.ts';
import type { ApiKey, Repo, StoredResponsesItem } from '../../src/repo/types.ts';
import { collectSpilledFiles } from '../../src/scheduled/spilled-files.ts';
import { initFileStore, MemoryFileStore } from '@floway-dev/platform';

const RETENTION_SECONDS = 24 * 60 * 60;
const DAY_MS = RETENTION_SECONDS * 1000;
const DAY_ZERO = Date.UTC(2026, 0, 1);
const atDay = (day: number, milliseconds = 0): number => DAY_ZERO + day * DAY_MS + milliseconds;

afterEach(() => vi.useRealTimers());

const apiKey = (responsesRetentionSeconds = RETENTION_SECONDS): ApiKey => ({
  id: 'key-a',
  userId: 1,
  name: 'State key',
  key: 'raw-state-key',
  serverSecret: '11'.repeat(32),
  createdAt: '2026-01-01T00:00:00.000Z',
  upstreamIds: null,
  deletedAt: null,
  dumpRetentionSeconds: null,
  responsesRetentionSeconds,
});

const storedItem = (
  id: string,
  refreshedAt: number,
  content = id,
  apiKeyId = 'key-a',
): StoredResponsesItem => ({
  id,
  apiKeyId,
  payload: { item: { type: 'message', id, role: 'assistant', content } },
  itemHash: `hash-${content}`,
  refreshedAt,
});

const largeContent = (): string => Array.from({ length: 4_096 }, () => crypto.randomUUID()).join('');

const backends: Array<readonly [string, () => Promise<Repo>]> = [
  ['memory', async () => new InMemoryRepo()],
  ['sql', async () => new SqlRepo(await createSqliteTestDb())],
];

describe.each(backends)('%s Responses state repository', (_backend, makeRepo) => {
  test('scopes exact and content-hash reads by key and rolling cutoff', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(atDay(4));
    initFileStore(new MemoryFileStore());
    const repo = await makeRepo();
    await repo.apiKeys.save(apiKey(7 * RETENTION_SECONDS));
    await repo.apiKeys.save({ ...apiKey(7 * RETENTION_SECONDS), id: 'key-b', key: 'raw-key-b', serverSecret: '22'.repeat(32) });
    const old = storedItem('msg-old', atDay(1), 'same');
    const current = storedItem('msg-current', atDay(2), 'same');
    const foreign = storedItem('msg-foreign', atDay(2), 'same', 'key-b');
    await repo.responsesItems.insertMany([old, current, foreign], 0);

    expect(await repo.responsesItems.lookupMany('key-a', [old.id, current.id], atDay(1, 1))).toEqual([current]);
    expect(await repo.responsesItems.lookupMany('key-b', [current.id], 0)).toEqual([]);
    expect(await repo.responsesItems.lookupManyByItemHash('key-a', [current.itemHash], 0)).toEqual([current, old]);
  });

  test('rejects a live producer-ID collision but replaces an expired row', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(atDay(11, DAY_MS / 2));
    initFileStore(new MemoryFileStore());
    const repo = await makeRepo();
    await repo.apiKeys.save(apiKey());
    const original = storedItem('msg-collision', atDay(10), 'original');
    const replacement = storedItem('msg-collision', atDay(12), 'replacement');
    await repo.responsesItems.insertMany([original], 0);

    await expect(repo.responsesItems.insertMany([replacement], atDay(9))).rejects.toThrow('id collision');
    vi.setSystemTime(atDay(12, 1));
    await expect(repo.responsesItems.insertMany([replacement], atDay(10, 1))).resolves.toBeUndefined();
    expect(await repo.responsesItems.lookupMany('key-a', [original.id], atDay(10, 1))).toEqual([replacement]);
  });

  test('refreshes only active rows and never lowers their timestamp', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(atDay(11, DAY_MS / 2));
    initFileStore(new MemoryFileStore());
    const repo = await makeRepo();
    await repo.apiKeys.save(apiKey());
    const item = storedItem('msg-refresh', atDay(10));
    await repo.responsesItems.insertMany([item], 0);

    await repo.responsesItems.refreshMany([item], atDay(11, 1_000), atDay(9));
    await repo.responsesItems.refreshMany([item], atDay(11, DAY_MS - 1), atDay(9));
    expect((await repo.responsesItems.lookupMany('key-a', [item.id], 0))[0].refreshedAt).toBe(atDay(11));
    await expect(repo.responsesItems.refreshMany([item], atDay(12), atDay(11, 1))).rejects.toThrow('disappeared');
  });

  test('deletes rows outside each key current rolling policy', async () => {
    initFileStore(new MemoryFileStore());
    const repo = await makeRepo();
    const now = atDay(10);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    await repo.apiKeys.save(apiKey(2 * RETENTION_SECONDS));
    const expired = storedItem('msg-expired', responsesStateCutoff(now, RETENTION_SECONDS) - 1);
    const current = storedItem('msg-current', responsesStateCutoff(now, RETENTION_SECONDS));
    await repo.responsesItems.insertMany([expired, current], 0);
    await repo.responsesSnapshots.insert({ id: 'resp-expired', apiKeyId: 'key-a', itemIds: [expired.id], refreshedAt: expired.refreshedAt });
    await repo.responsesSnapshots.insert({ id: 'resp-current', apiKeyId: 'key-a', itemIds: [current.id], refreshedAt: current.refreshedAt });
    await repo.apiKeys.update('key-a', { responsesRetentionSeconds: RETENTION_SECONDS });

    expect(await repo.responsesItems.deleteExpiredBatch('key-a', now, 100)).toBe(1);
    expect(await repo.responsesSnapshots.deleteExpiredBatch('key-a', now, 100)).toBe(1);
    expect(await repo.responsesItems.lookupMany('key-a', [expired.id, current.id], 0)).toEqual([current]);
    expect(await repo.responsesSnapshots.lookup('key-a', 'resp-expired', 0)).toBeNull();
    expect(await repo.responsesSnapshots.lookup('key-a', 'resp-current', 0)).not.toBeNull();

    await repo.apiKeys.update('key-a', { responsesRetentionSeconds: 0 });
    expect(await repo.responsesItems.deleteExpiredBatch('key-a', now, 100)).toBe(1);
    expect(await repo.responsesSnapshots.deleteExpiredBatch('key-a', now, 100)).toBe(1);
  });

  test('keeps the newest snapshot payload while extending its refresh timestamp', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(atDay(4));
    const repo = await makeRepo();
    await repo.apiKeys.save(apiKey());
    await repo.responsesSnapshots.insert({ id: 'resp-a', apiKeyId: 'key-a', itemIds: ['new'], refreshedAt: atDay(3) });
    await repo.responsesSnapshots.insert({ id: 'resp-a', apiKeyId: 'key-a', itemIds: ['old'], refreshedAt: atDay(2) });

    expect(await repo.responsesSnapshots.lookup('key-a', 'resp-a', 0)).toEqual({
      id: 'resp-a',
      apiKeyId: 'key-a',
      itemIds: ['new'],
      refreshedAt: atDay(3),
    });
    expect(await repo.responsesSnapshots.lookup('key-a', 'resp-a', atDay(3, 1))).toBeNull();
  });

  test('a concurrent shrink does not change an in-flight request retention snapshot', async () => {
    initFileStore(new MemoryFileStore());
    const repo = await makeRepo();
    const now = Date.now();
    const thirtyDays = 30 * 24 * 60 * 60;
    const sevenDays = 7 * 24 * 60 * 60;
    await repo.apiKeys.save(apiKey(thirtyDays));
    const old = storedItem('msg-shrink-race', now - 20 * 24 * 60 * 60_000);
    await repo.responsesItems.insertMany([old], responsesStateCutoff(now, thirtyDays));
    await repo.apiKeys.update('key-a', { responsesRetentionSeconds: sevenDays });

    await expect(repo.responsesItems.refreshMany([old], now, responsesStateCutoff(now, thirtyDays)))
      .resolves.toBeUndefined();
    expect((await repo.responsesItems.lookupMany('key-a', [old.id], 0))[0].refreshedAt)
      .toBe(quantizeResponsesRefreshedAt(now));
  });

  test('a concurrent grow does not widen an in-flight request retention snapshot', async () => {
    initFileStore(new MemoryFileStore());
    const repo = await makeRepo();
    const now = Date.now();
    const thirtyDays = 30 * 24 * 60 * 60;
    const sevenDays = 7 * 24 * 60 * 60;
    await repo.apiKeys.save(apiKey(thirtyDays));
    const old = storedItem('msg-grow-race', now - 20 * 24 * 60 * 60_000, 'old');
    await repo.responsesItems.insertMany([old], responsesStateCutoff(now, thirtyDays));
    await repo.apiKeys.update('key-a', { responsesRetentionSeconds: sevenDays });
    const replacement = storedItem(old.id, now, 'replacement');
    await repo.apiKeys.update('key-a', { responsesRetentionSeconds: thirtyDays });

    await expect(repo.responsesItems.insertMany([replacement], responsesStateCutoff(now, sevenDays)))
      .resolves.toBeUndefined();
    expect((await repo.responsesItems.lookupMany('key-a', [old.id], 0))[0].payload).toEqual(replacement.payload);
  });

  test('an in-flight request reuses its narrower retention snapshot after a concurrent grow', async () => {
    initFileStore(new MemoryFileStore());
    const repo = await makeRepo();
    const now = atDay(40, DAY_MS / 2);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const thirtyDays = 30 * RETENTION_SECONDS;
    const sevenDays = 7 * RETENTION_SECONDS;
    await repo.apiKeys.save(apiKey(thirtyDays));
    const old = storedItem('msg-grow-refresh', now - 20 * DAY_MS);
    await repo.responsesItems.insertMany([old], responsesStateCutoff(now, thirtyDays));
    await repo.apiKeys.update('key-a', { responsesRetentionSeconds: sevenDays });
    const reused = { ...old, refreshedAt: now };
    await repo.apiKeys.update('key-a', { responsesRetentionSeconds: thirtyDays });

    await repo.responsesItems.insertMany([reused], responsesStateCutoff(now, sevenDays));

    expect((await repo.responsesItems.lookupMany('key-a', [old.id], 0))[0].refreshedAt)
      .toBe(quantizeResponsesRefreshedAt(now));
  });

  test('growing retention reveals a surviving row inside the wider window', async () => {
    initFileStore(new MemoryFileStore());
    const repo = await makeRepo();
    const now = Date.now();
    const thirtyDays = 30 * 24 * 60 * 60;
    const sevenDays = 7 * 24 * 60 * 60;
    await repo.apiKeys.save(apiKey(thirtyDays));
    const old = storedItem('msg-grow-visible', now - 20 * 24 * 60 * 60_000);
    await repo.responsesItems.insertMany([old], responsesStateCutoff(now, thirtyDays));

    await repo.apiKeys.update('key-a', { responsesRetentionSeconds: sevenDays });
    expect(await repo.responsesItems.lookupMany('key-a', [old.id], responsesStateCutoff(now, sevenDays))).toEqual([]);
    await repo.apiKeys.update('key-a', { responsesRetentionSeconds: thirtyDays });
    expect(await repo.responsesItems.lookupMany('key-a', [old.id], responsesStateCutoff(now, thirtyDays))).toEqual([
      { ...old, refreshedAt: quantizeResponsesRefreshedAt(old.refreshedAt) },
    ]);
  });
  test('a concurrent disable does not cancel a captured durable writer', async () => {
    initFileStore(new MemoryFileStore());
    const repo = await makeRepo();
    const now = Date.now();
    await repo.apiKeys.save(apiKey(RETENTION_SECONDS));
    await repo.apiKeys.update('key-a', { responsesRetentionSeconds: 0 });
    const item = storedItem('msg-disabled-race', now);

    await expect(repo.responsesItems.insertMany([item], responsesStateCutoff(now, RETENTION_SECONDS))).resolves.toBeUndefined();
    expect(await repo.responsesItems.lookupMany('key-a', [item.id], 0)).toEqual([
      { ...item, refreshedAt: quantizeResponsesRefreshedAt(item.refreshedAt) },
    ]);
  });

  test('same-day reuse keeps the request snapshot after a concurrent disable', async () => {
    initFileStore(new MemoryFileStore());
    const repo = await makeRepo();
    const now = atDay(10, DAY_MS / 2);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    await repo.apiKeys.save(apiKey());
    const item = storedItem('msg-disabled-same-day', now);
    await repo.responsesItems.insertMany([item], responsesStateCutoff(now, RETENTION_SECONDS));
    await repo.apiKeys.update('key-a', { responsesRetentionSeconds: 0 });

    await expect(repo.responsesItems.insertMany(
      [{ ...item, refreshedAt: now + 1_000 }],
      responsesStateCutoff(now, RETENTION_SECONDS),
    )).resolves.toBeUndefined();
  });

  test('an old request cannot refresh a replacement payload under a reused ID', async () => {
    initFileStore(new MemoryFileStore());
    const repo = await makeRepo();
    const now = atDay(10, DAY_MS / 2);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    await repo.apiKeys.save(apiKey(2 * RETENTION_SECONDS));
    const original = storedItem('msg-reused', now - 2.5 * DAY_MS, 'original');
    await repo.responsesItems.insertMany([original], responsesStateCutoff(now, 2 * RETENTION_SECONDS));
    await repo.apiKeys.update('key-a', { responsesRetentionSeconds: RETENTION_SECONDS });
    const replacement = storedItem(original.id, now, 'replacement');
    await repo.responsesItems.insertMany([replacement], responsesStateCutoff(now, RETENTION_SECONDS));

    await expect(repo.responsesItems.refreshMany([original], now + 1, responsesStateCutoff(now, 2 * RETENTION_SECONDS)))
      .rejects.toThrow('id collision');
    expect((await repo.responsesItems.lookupMany('key-a', [original.id], 0))[0]).toEqual({
      ...replacement,
      refreshedAt: quantizeResponsesRefreshedAt(replacement.refreshedAt),
    });
  });

  test('missing keys reject writes while soft-deleted keys preserve captured requests', async () => {
    initFileStore(new MemoryFileStore());
    const repo = await makeRepo();
    const now = Date.now();
    const missing = storedItem('msg-missing-key', now);
    await expect(repo.responsesItems.insertMany([missing], 0)).rejects.toThrow();

    await repo.apiKeys.save(apiKey());
    const existing = storedItem('msg-deleted-key', now);
    await repo.responsesItems.insertMany([existing], 0);
    await repo.apiKeys.softDelete('key-a');
    await expect(repo.responsesItems.refreshMany([existing], now + DAY_MS, 0)).resolves.toBeUndefined();
    expect((await repo.responsesItems.lookupMany('key-a', [existing.id], 0))[0].refreshedAt)
      .toBe(quantizeResponsesRefreshedAt(now + DAY_MS));
  });
});

test('SQL spill ownership is first-class and the shared collector reclaims retired files', async () => {
  const db = await createSqliteTestDb();
  const repo = new SqlRepo(db);
  initRepo(repo);
  const files = new MemoryFileStore();
  initFileStore(files);
  const now = atDay(10, DAY_MS / 2);
  vi.useFakeTimers();
  vi.setSystemTime(now);
  await repo.apiKeys.save(apiKey(2 * RETENTION_SECONDS));
  const item = storedItem('msg-spilled', now - 2.5 * DAY_MS, largeContent());
  await repo.responsesItems.insertMany([item], 0);
  await repo.apiKeys.update('key-a', { responsesRetentionSeconds: RETENTION_SECONDS });

  const owned = await db.prepare(
    "SELECT file_key, owner_kind, owner_key, state FROM spilled_files WHERE state = 'owned'",
  ).first<{ file_key: string; owner_kind: string; owner_key: string; state: string }>();
  if (owned === null) throw new Error('spill was not adopted');
  expect(owned.owner_kind).toBe('responses-item');
  expect(owned.owner_key).toBe(JSON.stringify([item.apiKeyId, item.id]));
  expect(await files.get(owned.file_key)).not.toBeNull();
  expect((await db.prepare('SELECT payload_json FROM responses_items WHERE id = ?').bind(item.id).first<{ payload_json: string }>())?.payload_json)
    .not.toContain(owned.file_key);

  expect(await repo.responsesItems.deleteExpiredBatch('key-a', now, 100)).toBe(1);
  expect((await db.prepare('SELECT state FROM spilled_files WHERE file_key = ?').bind(owned.file_key).first<{ state: string }>())?.state)
    .toBe('retired');
  await collectSpilledFiles(now);
  expect(await files.get(owned.file_key)).toBeNull();
  expect(await db.prepare('SELECT file_key FROM spilled_files WHERE file_key = ?').bind(owned.file_key).first()).toBeNull();
});

test('SQL performs no item or snapshot mutation after an earlier refresh in the same UTC day', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(atDay(10, DAY_MS / 4));
  const db = await createSqliteTestDb();
  const repo = new SqlRepo(db);
  initFileStore(new MemoryFileStore());
  await repo.apiKeys.save(apiKey());
  const item = storedItem('msg-daily-refresh', atDay(10, 1_000));
  const snapshot = { id: 'resp-daily-refresh', apiKeyId: 'key-a', itemIds: [item.id], refreshedAt: atDay(10, 1_000) };
  await repo.responsesItems.insertMany([item], 0);
  await repo.responsesSnapshots.insert(snapshot);

  const totalChanges = async (): Promise<number> => {
    const row = await db.prepare('SELECT total_changes() AS value').first<{ value: number }>();
    if (row === null) throw new Error('SQLite did not return total_changes()');
    return row.value;
  };
  const beforeSameDayReuse = await totalChanges();
  await repo.responsesItems.refreshMany([item], atDay(10, DAY_MS - 1), 0);
  await repo.responsesSnapshots.insert({ ...snapshot, refreshedAt: atDay(10, DAY_MS - 1) });
  expect(await totalChanges()).toBe(beforeSameDayReuse);

  vi.setSystemTime(atDay(11, 1_000));
  await repo.responsesItems.refreshMany([item], atDay(11, 1_000), 0);
  await repo.responsesSnapshots.insert({ ...snapshot, refreshedAt: atDay(11, 1_000) });
  expect(await totalChanges()).toBe(beforeSameDayReuse + 2);
});

test('SQL hydration retries with every current item identity column after a replacement race', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(atDay(11));
  const db = await createSqliteTestDb();
  const repo = new SqlRepo(db);
  const files = new MemoryFileStore();
  initFileStore(files);
  await repo.apiKeys.save(apiKey());
  const original = storedItem('msg-hydration-race', atDay(10), largeContent());
  const replacement = storedItem(original.id, atDay(11), 'replacement');
  await repo.responsesItems.insertMany([original], 0);
  const prepared = await prepareStoredResponsesPayload(replacement.id, replacement.apiKeyId, replacement.payload);
  if (prepared.file !== null) throw new Error('replacement payload unexpectedly spilled');
  const payloadHash = await hashResponsesJson(replacement.payload);
  vi.spyOn(files, 'get').mockImplementationOnce(async () => {
    await db.prepare(
      `UPDATE responses_items
       SET payload_json = ?, item_hash = ?, payload_hash = ?, payload_file_key = NULL, refreshed_at = ?
       WHERE id = ? AND api_key_id = ?`,
    ).bind(
      prepared.payloadJson,
      replacement.itemHash,
      payloadHash,
      replacement.refreshedAt,
      replacement.id,
      replacement.apiKeyId,
    ).run();
    return null;
  });

  expect(await repo.responsesItems.lookupMany(replacement.apiKeyId, [replacement.id], 0)).toEqual([replacement]);
});

test('a collector claim prevents a staged file from being adopted', async () => {
  const db = await createSqliteTestDb();
  const repo = new SqlRepo(db);
  const fileKey = 'responses-items/v2/objects/staged.gz';
  await db.prepare(
    `INSERT INTO spilled_files (file_key, owner_kind, owner_key, state, collect_after)
     VALUES (?, 'responses-item', json_array('key-a', 'msg-a'), 'staged', 0)`,
  ).bind(fileKey).run();
  expect(await repo.spilledFiles.claimCollectible('claim-a', 1, 0, 1)).toEqual([fileKey]);

  expect(() => db.prepare(
    `INSERT INTO responses_items
     (id, api_key_id, payload_json, item_hash, payload_file_key, refreshed_at)
     VALUES ('msg-a', 'key-a', '{"version":1,"storage":"file","encoding":"gzip","sha256":"aa","byteLength":1}', 'hash', ?, 1)`,
  ).bind(fileKey).run()).toThrow('not staged');
});

test('migration 0065 performs one direct cutover to disabled rolling state', async () => {
  const db = await createSqlJsDatabase();
  try {
    for (const [filename, sql] of migrationSqlByFilename) {
      if (filename === '0065_responses_state.sql') break;
      db.run(sql);
    }
    db.run(
      `INSERT INTO api_keys
       (id, user_id, name, key, server_secret, created_at, last_used_at, upstream_ids, deleted_at, dump_retention_seconds)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['key-a', 1, 'State', 'raw-state', '11'.repeat(32), '2026-01-01T00:00:00Z', null, null, null, null],
    );
    db.run('INSERT INTO responses_items VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ['msg-old', 'key-a', 'provider-a', 'msg-raw', 'message', '{}', 'hash', 1_000]);

    const migration = migrationSqlByFilename.find(([filename]) => filename === '0065_responses_state.sql');
    if (migration === undefined) throw new Error('missing migration 0065_responses_state.sql');
    db.run(migration[1]);

    expect(db.exec('SELECT * FROM responses_items')[0]?.values ?? []).toEqual([]);
    expect(db.exec('SELECT * FROM responses_snapshots')[0]?.values ?? []).toEqual([]);
    expect(db.exec("SELECT responses_retention_seconds FROM api_keys WHERE id = 'key-a'")[0].values).toEqual([[0]]);
    expect(db.exec('PRAGMA table_info(api_keys)')[0].values.map(row => row[1])).toEqual([
      'id',
      'user_id',
      'name',
      'key',
      'created_at',
      'last_used_at',
      'upstream_ids',
      'deleted_at',
      'dump_retention_seconds',
      'server_secret',
      'responses_retention_seconds',
    ]);
    expect(db.exec('PRAGMA table_info(responses_items)')[0].values.map(row => row[1])).toEqual([
      'id',
      'api_key_id',
      'payload_json',
      'item_hash',
      'payload_hash',
      'payload_file_key',
      'refreshed_at',
    ]);
    expect(db.exec('PRAGMA table_info(spilled_files)')[0].values.map(row => row[1])).toEqual([
      'file_key',
      'owner_kind',
      'owner_key',
      'state',
      'collect_after',
      'claim_token',
      'claimed_at',
    ]);
  } finally {
    db.close();
  }
});
