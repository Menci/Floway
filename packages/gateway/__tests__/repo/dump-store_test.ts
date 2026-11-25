import { expect, test } from 'vitest';

import { createSqliteTestDb, createSqlJsDatabase, mapRunChangeCount, migrationSqlByFilename, wrapSqlJsDatabase } from './test-sqlite.ts';
import { FileDumpStore } from '../../src/repo/dump-store.ts';
import { initRepo } from '../../src/repo/index.ts';
import { SqlRepo } from '../../src/repo/sql.ts';
import { collectSpilledFiles } from '../../src/scheduled/spilled-files.ts';
import { archiveBody, archiveMetadata, dumpContents, writeArchive } from '../dump/archive-fixtures.ts';
import { initFileStore, MemoryFileStore } from '@floway-dev/platform';
import type { SqlDatabase } from '@floway-dev/platform';

const openDb = async (): Promise<SqlDatabase> => {
  const db = await createSqliteTestDb();
  await new SqlRepo(db).apiKeys.save({
    id: 'key_x', userId: 1, name: 'Dump key', key: 'raw-dump-key', serverSecret: '44'.repeat(32),
    createdAt: '2026-01-01T00:00:00.000Z', upstreamIds: null, randomizeUpstreams: false,
    deletedAt: null, dumpRetentionSeconds: 86400, openaiResponsesRetentionSeconds: 0,
  });
  return db;
};

test('adopts an archive only when its index row is committed and reads the exact bytes', async () => {
  const db = await openDb();
  const files = new MemoryFileStore();
  const store = new FileDumpStore(db, files).archives;
  const commit = await store.writeArchive('key_x', 'archive', archiveBody());
  expect(await store.list('key_x', { limit: 10 })).toEqual([]);
  expect(await db.prepare("SELECT state FROM spilled_files WHERE file_key = 'dumps/v2/key_x/archive.ndjson'").first()).toEqual({ state: 'staged' });

  const metadata = archiveMetadata('archive', Date.now());
  await commit(metadata, null);
  expect(await store.list('key_x', { limit: 10 })).toEqual([{ ...metadata, upstream: null }]);
  expect(await db.prepare("SELECT state FROM spilled_files WHERE file_key = 'dumps/v2/key_x/archive.ndjson'").first()).toEqual({ state: 'owned' });
  expect(await new Response(await store.get('key_x', 'archive')).text()).toBe(dumpContents);
  expect(await store.get('unknown', 'archive')).toBeNull();
});

test('filters and pages the retained index, retires expired bytes and counts only deleted records', async () => {
  const db = await openDb();
  const files = new MemoryFileStore();
  initRepo(new SqlRepo(db));
  initFileStore(files);
  const store = new FileDumpStore(mapRunChangeCount(db, changes => changes * 3), files);
  const now = Date.now();
  await writeArchive(store.archives, 'key_x', archiveMetadata('old', now - 2 * 86400 * 1000));
  await writeArchive(store.archives, 'key_x', archiveMetadata('a-failed', now, { status: 429, model: 'wanted' }));
  await writeArchive(store.archives, 'key_x', archiveMetadata('b-newer', now));
  expect(await store.archives.get('key_x', 'old')).toBeNull();
  expect((await store.archives.list('key_x', { limit: 1 })).map(({ id }) => id)).toEqual(['b-newer']);
  expect((await store.archives.list('key_x', { limit: 1, before: 'b-newer' })).map(({ id }) => id)).toEqual(['a-failed']);
  expect((await store.archives.list('key_x', { limit: 1, failures: true, q: 'WANTED' })).map(({ id }) => id)).toEqual(['a-failed']);

  expect(await store.deleteExpiredBatch('key_x', now, 10)).toBe(1);
  await collectSpilledFiles(now);
  expect(await files.get('dumps/v2/key_x/old.ndjson')).toBeNull();
  expect(await files.get('dumps/v2/key_x/b-newer.ndjson')).not.toBeNull();
});

test('purges edge records and queues their files and staged orphans for physical collection', async () => {
  const raw = await createSqlJsDatabase();
  const migration = '0102_pipeline_dump_archives.sql';
  for (const [file, sql] of migrationSqlByFilename) {
    if (file === migration) break;
    raw.run(sql);
  }
  const files = new MemoryFileStore();
  const old = 'dumps/v1/key/1970010100/edge.req.gz';
  const orphan = 'dumps/v1/key/1970010100/orphan.resp.gz';
  const unrelated = 'responses/another-file.gz';
  await Promise.all([old, orphan, unrelated].map(key => files.put(key, Uint8Array.of(1))));
  raw.run(`INSERT INTO dump_records (key_id, id, created_at, meta_json, request_headers_json, request_body_descriptor)
    VALUES ('key', 'edge', 1000, '{}', '[]', ?)`, [JSON.stringify({ key: old, type: 'bytes' })]);
  raw.run('DELETE FROM spilled_files WHERE file_key = ?', [old]);
  raw.run(`INSERT INTO spilled_files (file_key, owner_kind, owner_key, state, collect_after) VALUES
    (?, 'dump-response', '["key", "orphan"]', 'staged', 9999999),
    (?, 'responses-item', '["key", "item"]', 'owned', NULL)`, [orphan, unrelated]);

  raw.run(migrationSqlByFilename.find(([file]) => file === migration)![1]);
  const db = wrapSqlJsDatabase(raw);
  initRepo(new SqlRepo(db));
  initFileStore(files);
  expect(await db.prepare('SELECT COUNT(*) AS count FROM dump_records').first()).toEqual({ count: 0 });
  expect(await db.prepare("SELECT COUNT(*) AS count FROM cleanup_backfills WHERE source = 'dump_records'").first()).toEqual({ count: 0 });
  expect((await db.prepare("SELECT file_key FROM spilled_files WHERE state = 'retired' ORDER BY file_key").all()).results)
    .toEqual([{ file_key: old }, { file_key: orphan }]);
  await collectSpilledFiles(1);
  expect(await files.get(old)).toBeNull();
  expect(await files.get(orphan)).toBeNull();
  expect(await files.get(unrelated)).toEqual(Uint8Array.of(1));
});
