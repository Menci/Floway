import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { expect, test } from 'vitest';

import { createSqliteTestDb, mapRunChangeCount } from './test-sqlite.ts';
import { decodeDumpBodyDescriptor } from '../../src/dump/storage-codec.ts';
import type { StoredDumpRecord } from '../../src/dump/types.ts';
import { FileDumpStore } from '../../src/repo/dump-store.ts';
import { initRepo } from '../../src/repo/index.ts';
import { SqlRepo } from '../../src/repo/sql.ts';
import { collectSpilledFiles } from '../../src/scheduled/spilled-files.ts';
import { encodeRun, toNdjson, type Facts } from '@floway-dev/pipeline';
import { initFileStore, MemoryFileStore } from '@floway-dev/platform';
import type { FileStore, SqlDatabase } from '@floway-dev/platform';
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
    deletedAt: null,
    dumpRetentionSeconds: 10 * 365 * 24 * 60 * 60,
    openaiResponsesRetentionSeconds: 0,
  });
  return db;
};

// A turn is stored as its run: one NDJSON body file under the file-store contract, and a row
// carrying the metadata a list renders without opening it.
const runRecord = (id: string, completedAt: number): StoredDumpRecord => {
  const entered: Facts = { 'request.http.path': '/v1/embeddings' };
  const left: Facts = { ...entered, 'response.http.status': 200 };
  return {
    meta: {
      id, startedAt: completedAt - 1, completedAt, method: 'POST', path: '/v1/x', status: 200,
      upstream: null, model: 'm', inputTokens: 1, outputTokens: 2,
      requestBytes: 3, responseBytes: 4, durationMs: 1, error: null,
    },
    events: new TextEncoder().encode(toNdjson(encodeRun([
      { type: 'stage.entered', stageId: 1, name: 'serve', parentStageId: null, facts: entered },
      { type: 'stage.entered', stageId: 2, name: 'dial', parentStageId: 1, facts: entered },
      { type: 'stage.leaved', stageId: 2, facts: left },
      { type: 'stage.leaved', stageId: 1, facts: left },
    ]))),
  };
};

test('FileDumpStore round-trips a run record as its NDJSON event stream', async () => {
  const db = await openDb();
  const files = new MemoryFileStore();
  const store = new FileDumpStore(db, files);
  const record = runRecord('01HZZ00000000000000000RUN1', Date.UTC(2026, 5, 1, 12, 0, 0));

  await store.put('key_x', record);
  const fetched = await store.get('key_x', record.meta.id);
  assertExists(fetched);
  assertEquals(new TextDecoder().decode(fetched.events), new TextDecoder().decode(record.events));

  // The stream is a body file: gzipped, named for what it holds, and pointed at by the row's
  // response descriptor — which is also what says the row has a run to read.
  const row = await db.prepare('SELECT request_body_descriptor, response_body_descriptor FROM dump_records WHERE key_id = ? AND id = ?')
    .bind('key_x', record.meta.id)
    .first<{ request_body_descriptor: string | null; response_body_descriptor: string }>();
  assertExists(row);
  assertEquals(row.request_body_descriptor, null);
  const descriptor = decodeDumpBodyDescriptor(row.response_body_descriptor, 'test run descriptor');
  assertEquals(descriptor.type, 'run');
  assertEquals(descriptor.key.endsWith('.run.gz'), true);
});

test('FileDumpStore lists what a row renders without opening the stream', async () => {
  const db = await openDb();
  const store = new FileDumpStore(db, new MemoryFileStore());
  const base = Date.UTC(2026, 5, 1, 12, 0, 0);
  await store.put('key_x', runRecord('01HZZ00000000000000000RUN1', base));
  await store.put('key_x', runRecord('01HZZ00000000000000000RUN2', base + 1));

  const listed = await store.list('key_x', { limit: 10 });
  assertEquals(listed.map(meta => meta.id), ['01HZZ00000000000000000RUN2', '01HZZ00000000000000000RUN1']);
  // Every column a row renders is filled from the metadata, so a list costs no file read.
  assertEquals(listed.map(meta => meta.model), ['m', 'm']);
  assertEquals(listed.map(meta => meta.status), [200, 200]);
});

test('FileDumpStore retires an expired run record and collects its stream file', async () => {
  const db = await openDb();
  const repo = new SqlRepo(db);
  initRepo(repo);
  const files = new MemoryFileStore();
  initFileStore(files);
  const store = new FileDumpStore(db, files);
  const now = Date.UTC(2026, 5, 1, 12, 0, 0);
  await store.put('key_x', runRecord('01HZZ00000000000000000RUN3', Date.UTC(2026, 5, 1, 9, 0, 0)));
  await store.put('key_x', runRecord('01HZZ00000000000000000RUN4', now));
  await repo.apiKeys.update('key_x', { dumpRetentionSeconds: 2 * 3600 });

  const originalNow = Date.now;
  Date.now = () => now + 1;
  try {
    assertEquals((await store.list('key_x', { limit: 10 })).map(meta => meta.id), ['01HZZ00000000000000000RUN4']);
    assertEquals(await store.get('key_x', '01HZZ00000000000000000RUN3'), null);
    assertEquals(await store.deleteExpiredBatch('key_x', now + 1, 100), 1);
    await collectSpilledFiles(now + 1);
  } finally {
    Date.now = originalNow;
  }

  const { results: remaining } = await db
    .prepare("SELECT file_key FROM spilled_files WHERE state = 'owned' ORDER BY file_key")
    .all<{ file_key: string }>();
  assertEquals(remaining.map(row => row.file_key.endsWith('.run.gz')), [true]);
  assertEquals(remaining.every(row => !row.file_key.includes('2026060109')), true);
});

test('FileDumpStore rejects malformed metadata with its row identity', async () => {
  const db = await openDb();
  const store = new FileDumpStore(db, new MemoryFileStore());
  const record = runRecord('01HZZ000000000000000000BADM', Date.UTC(2026, 5, 1, 12));
  await store.put('key_x', record);
  await db.prepare('UPDATE dump_records SET meta_json = ? WHERE key_id = ? AND id = ?')
    .bind(JSON.stringify({ ...record.meta, upstream: undefined, status: '200' }), 'key_x', record.meta.id)
    .run();

  await expect(store.list('key_x', { limit: 10 }))
    .rejects.toThrow(/Invalid dump record 01HZZ000000000000000000BADM metadata.*status/su);
});

test('FileDumpStore rejects a malformed body descriptor before file access', async () => {
  const db = await openDb();
  const store = new FileDumpStore(db, new MemoryFileStore());
  const record = runRecord('01HZZ000000000000000000BADD', Date.UTC(2026, 5, 1, 12));
  await store.put('key_x', record);
  await db.prepare('UPDATE dump_records SET response_body_descriptor = ? WHERE key_id = ? AND id = ?')
    .bind(JSON.stringify({ key: 'dumps/v1/key_x/run.gz', type: 'chunks' }), 'key_x', record.meta.id)
    .run();

  await expect(store.get('key_x', record.meta.id))
    .rejects.toThrow(/Invalid dump record 01HZZ000000000000000000BADD response body descriptor.*type/su);
});

// A row whose descriptor is well-formed but names something other than a run has no stream to
// read, and the migration that deleted the shape which wrote those leaves none — so it is
// corruption, and the reader says so rather than handing back half a record.
test('FileDumpStore refuses a row that points at no run stream', async () => {
  const db = await openDb();
  const store = new FileDumpStore(db, new MemoryFileStore());
  const record = runRecord('01HZZ000000000000000000NORUN', Date.UTC(2026, 5, 1, 12));
  await store.put('key_x', record);
  await db.prepare('UPDATE dump_records SET response_body_descriptor = ? WHERE key_id = ? AND id = ?')
    .bind(JSON.stringify({ key: 'dumps/v1/key_x/run.gz', type: 'bytes' }), 'key_x', record.meta.id)
    .run();

  await expect(store.get('key_x', record.meta.id))
    .rejects.toThrow(/dump record 01HZZ000000000000000000NORUN has no run stream to read/u);
});

test('FileDumpStore.list paginates newest-first with the (createdAt, id) cursor', async () => {
  const db = await openDb();
  const files = new MemoryFileStore();
  const store = new FileDumpStore(db, files);
  const base = Date.UTC(2026, 5, 1, 12, 0, 0);
  for (let i = 0; i < 5; i++) {
    await store.put('key_x', runRecord(`01HZZ000000000000000000A0${i}`, base + i));
  }
  const first = await store.list('key_x', { limit: 2 });
  assertEquals(first.map(m => m.id), ['01HZZ000000000000000000A04', '01HZZ000000000000000000A03']);
  const next = await store.list('key_x', { limit: 2, before: '01HZZ000000000000000000A03' });
  assertEquals(next.map(m => m.id), ['01HZZ000000000000000000A02', '01HZZ000000000000000000A01']);
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
  await store.put('key_x', runRecord('01HZZ0000000000000000000A1', Date.UTC(2026, 5, 1, 9, 0, 0)));
  await store.put('key_x', runRecord('01HZZ0000000000000000000A2', now));
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

test('growing dump retention can reveal a row not yet physically deleted', async () => {
  const db = await openDb();
  const repo = new SqlRepo(db);
  const files = new MemoryFileStore();
  const store = new FileDumpStore(db, files);
  const now = Date.UTC(2026, 5, 1, 12);
  await store.put('key_x', runRecord('01HZZ0000000000000000000A4', now - 3 * 3600_000));
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    await repo.apiKeys.update('key_x', { dumpRetentionSeconds: 2 * 3600 });
    assertEquals(await store.list('key_x', { limit: 10 }), []);
    await repo.apiKeys.update('key_x', { dumpRetentionSeconds: 4 * 3600 });
    assertEquals((await store.list('key_x', { limit: 10 })).map(row => row.id), ['01HZZ0000000000000000000A4']);
  } finally {
    Date.now = originalNow;
  }
});

test('FileDumpStore retires every dump record when retention is disabled and collects its exact files', async () => {
  const db = await openDb();
  const repo = new SqlRepo(db);
  initRepo(repo);
  const files = new MemoryFileStore();
  initFileStore(files);
  const store = new FileDumpStore(db, files);
  await store.put('key_x', runRecord('01HZZ0000000000000000000A1', Date.UTC(2026, 5, 1, 9, 0, 0)));
  await store.put('key_x', runRecord('01HZZ0000000000000000000A2', Date.UTC(2026, 5, 1, 12, 0, 0)));
  await repo.apiKeys.update('key_x', { dumpRetentionSeconds: null });
  assertEquals((await store.list('key_x', { limit: 10 })).length, 0);
  assertEquals(await store.deleteExpiredBatch('key_x', Date.now(), 100), 2);
  assertEquals((await db.prepare('SELECT COUNT(*) AS count FROM dump_records WHERE key_id = ?').bind('key_x').first<{ count: number }>())?.count, 0);
  await collectSpilledFiles(Date.now());
  assertEquals((await db.prepare('SELECT COUNT(*) AS count FROM spilled_files').first<{ count: number }>())?.count, 0);
});

test('FileDumpStore counts returned dump rows instead of trigger-amplified changes', async () => {
  const db = await openDb();
  const repo = new SqlRepo(db);
  const files = new MemoryFileStore();
  const store = new FileDumpStore(db, files);
  await store.put('key_x', runRecord('01HZZ0000000000000000000C1', Date.UTC(2026, 5, 1, 9)));
  await store.put('key_x', runRecord('01HZZ0000000000000000000C2', Date.UTC(2026, 5, 1, 10)));
  await repo.apiKeys.update('key_x', { dumpRetentionSeconds: null });

  const d1LikeStore = new FileDumpStore(mapRunChangeCount(db, changes => changes * 3), files);
  expect(await d1LikeStore.deleteExpiredBatch('key_x', Date.now(), 1)).toBe(1);
  expect((await db.prepare('SELECT COUNT(*) AS count FROM dump_records').first<{ count: number }>())?.count).toBe(1);
});

test('FileDumpStore counts returned active dump rows instead of trigger-amplified changes', async () => {
  const db = await openDb();
  const repo = new SqlRepo(db);
  const files = new MemoryFileStore();
  const store = new FileDumpStore(db, files);
  const now = Date.UTC(2026, 5, 1, 12);
  await store.put('key_x', runRecord('01HZZ0000000000000000000C3', Date.UTC(2026, 5, 1, 9)));
  await store.put('key_x', runRecord('01HZZ0000000000000000000C4', Date.UTC(2026, 5, 1, 10)));
  await repo.apiKeys.update('key_x', { dumpRetentionSeconds: 3600 });

  const d1LikeStore = new FileDumpStore(mapRunChangeCount(db, changes => changes * 3), files);
  expect(await d1LikeStore.deleteExpiredBatch('key_x', now, 1)).toBe(1);
  expect((await db.prepare('SELECT COUNT(*) AS count FROM dump_records').first<{ count: number }>())?.count).toBe(1);
});

test('a record-ID race leaves only the losing write\'s uniquely keyed files collectible', async () => {
  const db = await openDb();
  const repo = new SqlRepo(db);
  initRepo(repo);
  const files = new MemoryFileStore();
  initFileStore(files);
  const store = new FileDumpStore(db, files);
  const record = runRecord('01HZZ0000000000000000000A3', Date.now());
  await store.put('key_x', record);

  // One file per record now — the run's own stream — so the winner owns one and the loser
  // staged one under a key of its own.
  await expect(store.put('key_x', record)).rejects.toThrow();
  expect((await db.prepare("SELECT COUNT(*) AS count FROM spilled_files WHERE state = 'owned'").first<{ count: number }>())?.count).toBe(1);
  expect((await db.prepare("SELECT COUNT(*) AS count FROM spilled_files WHERE state = 'staged'").first<{ count: number }>())?.count).toBe(1);

  await collectSpilledFiles(Date.now() + 60 * 60 * 1000 + 1);
  expect((await db.prepare("SELECT COUNT(*) AS count FROM spilled_files WHERE state = 'staged'").first<{ count: number }>())?.count).toBe(0);
  expect((await db.prepare("SELECT COUNT(*) AS count FROM spilled_files WHERE state = 'owned'").first<{ count: number }>())?.count).toBe(1);
  assertExists(await store.get('key_x', record.meta.id));
});

test('FileDumpStore expiration against a never-written key resolves without throwing', async () => {
  const db = await openDb();
  const files = new MemoryFileStore();
  const store = new FileDumpStore(db, files);
  assertEquals((await store.list('never_written_key', { limit: 10 })).length, 0);
  assertEquals(await store.deleteExpiredBatch('never_written_key', Date.now(), 100), 0);
  assertEquals((await db.prepare("SELECT COUNT(*) AS count FROM dump_records WHERE key_id = 'never_written_key'").first<{ count: number }>())?.count, 0);
});

// Smoke test: drive FileDumpStore against a real-filesystem FileStore so a
// regression where the store leans on MemoryFileStore's stricter ordering /
// instant durability surfaces here. The inline FileStore mirrors the shape
// of the Node platform-target app's `FsFileStore` — keeping this test in
// gateway, not in apps/platform-node, is what lets that app's src/ tree stay
// free of business-domain knowledge.
class TmpDirFileStore implements FileStore {
  constructor(private readonly root: string) {}
  async put(key: string, body: Uint8Array): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }
  async get(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.pathFor(key)));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }
  async deleteKeys(keys: readonly string[]): Promise<void> {
    await Promise.all(keys.map(async key => await rm(this.pathFor(key), { force: true })));
  }
  private pathFor(key: string): string {
    return resolve(this.root, ...key.split('/'));
  }
}

test('FileDumpStore: put + get round-trips through real-filesystem IO', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dump-store-'));
  try {
    const db = await openDb();
    const store = new FileDumpStore(db, new TmpDirFileStore(join(root, 'files')));
    const record = runRecord('01HZZ0000000000000000000A1', Date.UTC(2026, 5, 1, 12, 0, 0));

    await store.put('key_x', record);
    const fetched = await store.get('key_x', '01HZZ0000000000000000000A1');
    assertExists(fetched);
    assertEquals(new TextDecoder().decode(fetched.events), new TextDecoder().decode(record.events));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
