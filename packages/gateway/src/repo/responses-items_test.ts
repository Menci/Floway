import initSqlJs from 'sql.js';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { initRepo } from './index.ts';
import { InMemoryRepo } from './memory.ts';
import { responsesStateCutoff } from './responses-retention.ts';
import { collectSpilledFiles } from './spilled-files.ts';
import { SqlRepo } from './sql.ts';
import { createSqliteTestDb, migrationSqlByFilename } from './test-sqlite.ts';
import type { ApiKey, Repo, StoredResponsesItem } from './types.ts';
import { initFileProvider, MemoryFileProvider } from '@floway-dev/platform';

const RETENTION_SECONDS = 60 * 60;

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
  contentHash: `hash-${content}`,
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
    vi.setSystemTime(4_000);
    initFileProvider(new MemoryFileProvider());
    const repo = await makeRepo();
    await repo.apiKeys.save(apiKey());
    await repo.apiKeys.save({ ...apiKey(), id: 'key-b', key: 'raw-key-b', serverSecret: '22'.repeat(32) });
    const old = storedItem('msg-old', 1_000, 'same');
    const current = storedItem('msg-current', 2_000, 'same');
    const foreign = storedItem('msg-foreign', 2_000, 'same', 'key-b');
    await repo.responsesItems.insertMany([old, current, foreign], 0);

    expect(await repo.responsesItems.lookupMany('key-a', [old.id, current.id], 1_500)).toEqual([current]);
    expect(await repo.responsesItems.lookupMany('key-b', [current.id], 0)).toEqual([]);
    expect(await repo.responsesItems.lookupManyByContentHash('key-a', [current.contentHash], 0)).toEqual([current, old]);
  });

  test('rejects a live producer-ID collision but replaces an expired row', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(4_000);
    initFileProvider(new MemoryFileProvider());
    const repo = await makeRepo();
    await repo.apiKeys.save(apiKey());
    const original = storedItem('msg-collision', 1_000, 'original');
    const replacement = storedItem('msg-collision', 3_000, 'replacement');
    await repo.responsesItems.insertMany([original], 0);

    await expect(repo.responsesItems.insertMany([replacement], 500)).rejects.toThrow('id collision');
    vi.setSystemTime(3_602_001);
    await expect(repo.responsesItems.insertMany([replacement], 2_000)).resolves.toBeUndefined();
    expect(await repo.responsesItems.lookupMany('key-a', [original.id], 2_000)).toEqual([replacement]);
  });

  test('refreshes only active rows and never lowers their timestamp', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(4_000);
    initFileProvider(new MemoryFileProvider());
    const repo = await makeRepo();
    await repo.apiKeys.save(apiKey());
    const item = storedItem('msg-refresh', 1_000);
    await repo.responsesItems.insertMany([item], 0);

    await repo.responsesItems.refreshMany([item], 3_000, 500);
    await repo.responsesItems.refreshMany([item], 2_000, 500);
    expect((await repo.responsesItems.lookupMany('key-a', [item.id], 0))[0].refreshedAt).toBe(3_000);
    await expect(repo.responsesItems.refreshMany([item], 4_000, 3_001)).rejects.toThrow('disappeared');
  });

  test('deletes rows outside each key current rolling policy', async () => {
    initFileProvider(new MemoryFileProvider());
    const repo = await makeRepo();
    const now = 10_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);
    await repo.apiKeys.save(apiKey(7_200));
    const expired = storedItem('msg-expired', responsesStateCutoff(now, 3_600) - 1);
    const current = storedItem('msg-current', responsesStateCutoff(now, 3_600));
    await repo.responsesItems.insertMany([expired, current], 0);
    await repo.responsesSnapshots.insert({ id: 'resp-expired', apiKeyId: 'key-a', itemIds: [expired.id], refreshedAt: expired.refreshedAt });
    await repo.responsesSnapshots.insert({ id: 'resp-current', apiKeyId: 'key-a', itemIds: [current.id], refreshedAt: current.refreshedAt });
    await repo.apiKeys.update('key-a', { responsesRetentionSeconds: 3_600 });

    expect(await repo.responsesItems.deleteExpired(now)).toBe(1);
    expect(await repo.responsesSnapshots.deleteExpired(now)).toBe(1);
    expect(await repo.responsesItems.lookupMany('key-a', [expired.id, current.id], 0)).toEqual([current]);
    expect(await repo.responsesSnapshots.lookup('key-a', 'resp-expired', 0)).toBeNull();
    expect(await repo.responsesSnapshots.lookup('key-a', 'resp-current', 0)).not.toBeNull();

    await repo.apiKeys.update('key-a', { responsesRetentionSeconds: 0 });
    expect(await repo.responsesItems.deleteExpired(now)).toBe(1);
    expect(await repo.responsesSnapshots.deleteExpired(now)).toBe(1);
  });

  test('keeps the newest snapshot payload while extending its refresh timestamp', async () => {
    const repo = await makeRepo();
    await repo.responsesSnapshots.insert({ id: 'resp-a', apiKeyId: 'key-a', itemIds: ['new'], refreshedAt: 2_000 });
    await repo.responsesSnapshots.insert({ id: 'resp-a', apiKeyId: 'key-a', itemIds: ['old'], refreshedAt: 1_000 });

    expect(await repo.responsesSnapshots.lookup('key-a', 'resp-a', 0)).toEqual({
      id: 'resp-a',
      apiKeyId: 'key-a',
      itemIds: ['new'],
      refreshedAt: 2_000,
    });
    expect(await repo.responsesSnapshots.lookup('key-a', 'resp-a', 2_001)).toBeNull();
  });

  test('a concurrent shrink prevents an old request from refreshing excluded state', async () => {
    initFileProvider(new MemoryFileProvider());
    const repo = await makeRepo();
    const now = Date.now();
    const thirtyDays = 30 * 24 * 60 * 60;
    const sevenDays = 7 * 24 * 60 * 60;
    await repo.apiKeys.save(apiKey(thirtyDays));
    const old = storedItem('msg-shrink-race', now - 20 * 24 * 60 * 60_000);
    await repo.responsesItems.insertMany([old], responsesStateCutoff(now, thirtyDays));
    await repo.apiKeys.update('key-a', { responsesRetentionSeconds: sevenDays });

    await expect(repo.responsesItems.refreshMany([old], now, responsesStateCutoff(now, thirtyDays)))
      .rejects.toThrow('disappeared');
    expect((await repo.responsesItems.lookupMany('key-a', [old.id], 0))[0].refreshedAt).toBe(old.refreshedAt);
  });

  test('a concurrent grow protects a newly-live producer ID from replacement', async () => {
    initFileProvider(new MemoryFileProvider());
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
      .rejects.toThrow('id collision');
    expect((await repo.responsesItems.lookupMany('key-a', [old.id], 0))[0].payload).toEqual(old.payload);
  });

  test('growing retention reveals a surviving row inside the wider window', async () => {
    initFileProvider(new MemoryFileProvider());
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
    expect(await repo.responsesItems.lookupMany('key-a', [old.id], responsesStateCutoff(now, thirtyDays))).toEqual([old]);
  });

  test('a concurrent disable prevents a captured durable writer from inserting', async () => {
    initFileProvider(new MemoryFileProvider());
    const repo = await makeRepo();
    const now = Date.now();
    await repo.apiKeys.save(apiKey(RETENTION_SECONDS));
    await repo.apiKeys.update('key-a', { responsesRetentionSeconds: 0 });
    const item = storedItem('msg-disabled-race', now);

    await expect(repo.responsesItems.insertMany([item], responsesStateCutoff(now, RETENTION_SECONDS))).rejects.toThrow();
    expect(await repo.responsesItems.lookupMany('key-a', [item.id], 0)).toEqual([]);
  });

  test('an old request cannot refresh a replacement payload under a reused ID', async () => {
    initFileProvider(new MemoryFileProvider());
    const repo = await makeRepo();
    const now = Date.now();
    await repo.apiKeys.save(apiKey(2 * RETENTION_SECONDS));
    const original = storedItem('msg-reused', now - 90 * 60_000, 'original');
    await repo.responsesItems.insertMany([original], responsesStateCutoff(now, 2 * RETENTION_SECONDS));
    await repo.apiKeys.update('key-a', { responsesRetentionSeconds: RETENTION_SECONDS });
    const replacement = storedItem(original.id, now, 'replacement');
    await repo.responsesItems.insertMany([replacement], responsesStateCutoff(now, RETENTION_SECONDS));

    await expect(repo.responsesItems.refreshMany([original], now + 1, responsesStateCutoff(now, 2 * RETENTION_SECONDS)))
      .rejects.toThrow('id collision');
    expect((await repo.responsesItems.lookupMany('key-a', [original.id], 0))[0]).toEqual(replacement);
  });
});

test('SQL spill ownership is first-class and the shared collector reclaims retired files', async () => {
  const db = await createSqliteTestDb();
  const repo = new SqlRepo(db);
  initRepo(repo);
  const files = new MemoryFileProvider();
  initFileProvider(files);
  const now = Date.now();
  await repo.apiKeys.save(apiKey(2 * RETENTION_SECONDS));
  const item = storedItem('msg-spilled', now - RETENTION_SECONDS * 1000 - 1, largeContent());
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

  expect(await repo.responsesItems.deleteExpired(now)).toBe(1);
  expect((await db.prepare('SELECT state FROM spilled_files WHERE file_key = ?').bind(owned.file_key).first<{ state: string }>())?.state)
    .toBe('retired');
  await collectSpilledFiles(now);
  expect(await files.get(owned.file_key)).toBeNull();
  expect(await db.prepare('SELECT file_key FROM spilled_files WHERE file_key = ?').bind(owned.file_key).first()).toBeNull();
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
     (id, api_key_id, payload_json, content_hash, payload_file_key, refreshed_at)
     VALUES ('msg-a', 'key-a', '{"version":1,"storage":"file","encoding":"gzip","sha256":"aa","byteLength":1}', 'hash', ?, 1)`,
  ).bind(fileKey).run()).toThrow('not staged');
});

test('migration 0065 performs one direct cutover to disabled rolling state', async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
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
      'content_hash',
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
