import { readFile } from 'node:fs/promises';

import { expect, test } from 'vitest';

import { createSqliteTestDb, mapRunChangeCount } from './test-sqlite.ts';
import type { DumpWriteRecord } from '../../src/dump/types.ts';
import { FileDumpStore } from '../../src/repo/dump-store.ts';
import { initRepo } from '../../src/repo/index.ts';
import { SqlRepo } from '../../src/repo/sql.ts';
import { collectSpilledFiles } from '../../src/scheduled/spilled-files.ts';
import { initFileStore, MemoryFileStore } from '@floway-dev/platform';
import type { SqlDatabase } from '@floway-dev/platform';
import { assertEquals, assertExists } from '@floway-dev/test-utils';

const openDb = async (): Promise<SqlDatabase> => {
  const db = await createSqliteTestDb();
  await new SqlRepo(db).apiKeys.save({
    id: 'key_x',
    userId: 1,
    name: 'Dump key',
    key: 'raw-dump-key',
    serverSecret: '44'.repeat(32),
    createdAt: '2026-01-01T00:00:00.000Z',
    upstreamIds: null,
    randomizeUpstreams: false,
    deletedAt: null,
    dumpRetentionSeconds: 10 * 365 * 24 * 60 * 60,
    openaiResponsesRetentionSeconds: 0,
  });
  return db;
};

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

const requestBody = utf8('{"hello":"world"}');

const baseRecord = (id: string, completedAt: number): DumpWriteRecord => ({
  meta: {
    id, startedAt: completedAt - 1, completedAt, method: 'POST', path: '/v1/x', status: 200,
    upstream: null, model: 'm', inputTokens: 1, outputTokens: 2,
    requestBytes: 3, responseBytes: 4, durationMs: 1, error: null,
  },
  request: {
    method: 'POST', path: '/v1/x',
    headers: [['content-type', 'application/json']],
    body: { encoding: 'identity', bytes: requestBody, decodedByteLength: requestBody.byteLength },
  },
  response: {
    status: 200,
    headers: [['content-type', 'application/json']],
    body: { type: 'bytes', body: utf8('{"id":"abc"}') },
  },
});

test('FileDumpStore streams the completed archive bytes and retires the adopted file when retention expires', async () => {
  const db = await openDb();
  const repo = new SqlRepo(db);
  initRepo(repo);
  const files = new MemoryFileStore();
  initFileStore(files);
  const store = new FileDumpStore(db, files);
  const now = Date.now();
  const { meta } = baseRecord('01HZZ0000000000000000000ND', now - 2_000);
  const ndjson = '{"type":"object","fromObjectId":1,"nodes":[{}]}\n{"type":"stage.entered","stageId":1,"name":"parse","facts":{"$":1}}\n{"type":"stage.leaved","stageId":1,"facts":{"$":1}}\n';
  await store.putArchive('key_x', meta, utf8(ndjson));
  const archive = await store.getArchive('key_x', meta.id);
  assertExists(archive);
  expect(await new Response(archive).text()).toBe(ndjson);
  const owned = await db.prepare("SELECT file_key FROM spilled_files WHERE state = 'owned' AND owner_kind = 'dump-response'").first<{ file_key: string }>();
  assertExists(owned);
  expect(await files.get(owned.file_key)).not.toBeNull();
  await repo.apiKeys.update('key_x', { dumpRetentionSeconds: 1 });
  expect(await store.getArchive('key_x', meta.id)).toBeNull();
  expect(await store.deleteExpiredBatch('key_x', now, 10)).toBe(1);
  await collectSpilledFiles(now + 60 * 60 * 1000);
  expect(await files.get(owned.file_key)).toBeNull();
});

test('the archive migration retires legacy files and preserves files referenced by retained archives', async () => {
  const db = await openDb();
  initRepo(new SqlRepo(db));
  const files = new MemoryFileStore();
  initFileStore(files);
  const store = new FileDumpStore(db, files);
  const now = Date.now();
  const archive = baseRecord('archive', now);
  const legacy = baseRecord('legacy', now);
  const archiveData = utf8('{"type":"object","fromObjectId":1,"nodes":[{}]}\n');
  await store.putArchive('key_x', archive.meta, archiveData);
  await store.put('key_x', { ...legacy, response: { status: 200, headers: [], body: { type: 'none' } } });
  const { results } = await db.prepare('SELECT owner_kind, file_key FROM spilled_files').all<{ owner_kind: string; file_key: string }>();
  const legacyFile = results.find(item => item.owner_kind === 'dump-request')!.file_key;
  const archiveFile = results.find(item => item.owner_kind === 'dump-response')!.file_key;
  await db.prepare("UPDATE dump_records SET response_body_descriptor = json_object('key', ?, 'type', 'bytes') WHERE id = 'legacy'")
    .bind(archiveFile).run();
  await db.exec(await readFile(new URL('../../migrations/0102_dump_archives.sql', import.meta.url), 'utf8'));
  expect((await store.list('key_x', { limit: 10 })).map(meta => meta.id)).toEqual(['archive']);
  await collectSpilledFiles(now + 1);
  expect(await files.get(legacyFile)).toBeNull();
  const retained = await store.getArchive('key_x', archive.meta.id);
  assertExists(retained);
  expect(await new Response(retained).text()).toBe(new TextDecoder().decode(archiveData));
});

test('FileDumpStore applies retention immediately and retires exact expired files', async () => {
  const db = await openDb();
  const repo = new SqlRepo(db);
  initRepo(repo);
  const files = new MemoryFileStore();
  initFileStore(files);
  const store = new FileDumpStore(db, files);
  const now = Date.UTC(2026, 5, 1, 12, 0, 0);
  // Old bucket 9:xx, current bucket 12:xx.
  await store.putArchive('key_x', baseRecord('01HZZ0000000000000000000A1', Date.UTC(2026, 5, 1, 9, 0, 0)).meta, utf8('archive A1'));
  await store.putArchive('key_x', baseRecord('01HZZ0000000000000000000A2', now).meta, utf8('archive A2'));
  await repo.apiKeys.update('key_x', { dumpRetentionSeconds: 2 * 3600 });
  const originalNow = Date.now;
  Date.now = () => now + 1;
  try {
    const left = await store.list('key_x', { limit: 10 });
    assertEquals(left.map(m => m.id), ['01HZZ0000000000000000000A2']);
    const afterExpiredCursor = await store.list('key_x', { limit: 10, before: '01HZZ0000000000000000000A1' });
    assertEquals(afterExpiredCursor, []);
    assertEquals(await store.deleteExpiredBatch('key_x', now + 1, 100), 1);
    const afterDeletedCursor = await store.list('key_x', { limit: 10, before: '01HZZ0000000000000000000A1' });
    assertEquals(afterDeletedCursor, []);
    await collectSpilledFiles(now + 1);
  } finally {
    Date.now = originalNow;
  }

  const { results: remainingFiles } = await db
    .prepare("SELECT file_key FROM spilled_files WHERE state = 'owned' ORDER BY file_key")
    .all<{ file_key: string }>();
  assertEquals(remainingFiles.every(row => !row.file_key.includes('2026060109')), true);
});

test('FileDumpStore counts returned dump rows instead of trigger-amplified changes', async () => {
  const db = await openDb();
  const repo = new SqlRepo(db);
  const files = new MemoryFileStore();
  const store = new FileDumpStore(db, files);
  await store.putArchive('key_x', baseRecord('01HZZ0000000000000000000C1', Date.UTC(2026, 5, 1, 9)).meta, utf8('archive C1'));
  await store.putArchive('key_x', baseRecord('01HZZ0000000000000000000C2', Date.UTC(2026, 5, 1, 10)).meta, utf8('archive C2'));
  await repo.apiKeys.update('key_x', { dumpRetentionSeconds: null });

  const d1LikeStore = new FileDumpStore(mapRunChangeCount(db, changes => changes * 3), files);
  expect(await d1LikeStore.deleteExpiredBatch('key_x', Date.now(), 1)).toBe(1);
  expect((await db.prepare('SELECT COUNT(*) AS count FROM dump_records').first<{ count: number }>())?.count).toBe(1);
});

test('a record-ID race leaves only the losing write\'s uniquely keyed files collectible', async () => {
  const db = await openDb();
  const repo = new SqlRepo(db);
  initRepo(repo);
  const files = new MemoryFileStore();
  initFileStore(files);
  const store = new FileDumpStore(db, files);
  const record = baseRecord('01HZZ0000000000000000000A3', Date.now());
  await store.putArchive('key_x', record.meta, utf8('winning archive'));

  await expect(store.putArchive('key_x', record.meta, utf8('losing archive'))).rejects.toThrow();
  expect((await db.prepare("SELECT COUNT(*) AS count FROM spilled_files WHERE state = 'owned'").first<{ count: number }>())?.count).toBe(1);
  expect((await db.prepare("SELECT COUNT(*) AS count FROM spilled_files WHERE state = 'staged'").first<{ count: number }>())?.count).toBe(1);

  await collectSpilledFiles(Date.now() + 60 * 60 * 1000 + 1);
  expect((await db.prepare("SELECT COUNT(*) AS count FROM spilled_files WHERE state = 'staged'").first<{ count: number }>())?.count).toBe(0);
  expect((await db.prepare("SELECT COUNT(*) AS count FROM spilled_files WHERE state = 'owned'").first<{ count: number }>())?.count).toBe(1);
  const surviving = await store.getArchive('key_x', record.meta.id);
  assertExists(surviving);
  expect(await new Response(surviving).text()).toBe('winning archive');
});

test('FileDumpStore filters all retained history before applying the page limit', async () => {
  const db = await openDb();
  const store = new FileDumpStore(db, new MemoryFileStore());
  const now = Date.now();
  for (let i = 0; i < 5; i++) {
    const record = baseRecord(`filter-${i}`, now - i);
    record.meta.model = i === 4 ? 'needle-model' : 'other';
    record.meta.error = i === 4 ? { kind: 'failed', reason: 'socket reset' } : null;
    await store.putArchive('key_x', record.meta, utf8('archive'));
  }
  expect((await store.list('key_x', { q: 'needle', limit: 1 })).map(meta => meta.id)).toEqual(['filter-4']);
  expect((await store.list('key_x', { q: 'SOCKET', failures: true, limit: 1 })).map(meta => meta.id)).toEqual(['filter-4']);
  expect(await store.list('key_x', { q: "' OR 1=1 --", limit: 1 })).toEqual([]);
  expect(await store.list('other-key', { q: 'needle', limit: 1 })).toEqual([]);
});
