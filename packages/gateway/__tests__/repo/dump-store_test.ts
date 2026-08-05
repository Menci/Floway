import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { expect, test } from 'vitest';

import { createSqliteTestDb } from './test-sqlite.ts';
import { decodeDumpBodyDescriptor } from '../../src/dump/storage-codec.ts';
import type { DumpWriteRecord } from '../../src/dump/types.ts';
import { FileDumpStore } from '../../src/repo/dump-store.ts';
import { initRepo } from '../../src/repo/index.ts';
import { SqlRepo } from '../../src/repo/sql.ts';
import { collectSpilledFiles } from '../../src/scheduled/spilled-files.ts';
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
    responsesRetentionSeconds: 0,
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

test('FileDumpStore prepares request gzip before terminal persistence', async () => {
  const db = await openDb();
  const files = new MemoryFileStore();
  const store = new FileDumpStore(db, files);
  const raw = utf8(`{"content":"${'repeatable '.repeat(4096)}"}`);
  const prepared = await store.prepareRequestBody(raw);
  const base = baseRecord('01HZZ0000000000000000000P1', Date.UTC(2026, 5, 1, 12, 0, 0));
  const record: DumpWriteRecord = {
    ...base,
    meta: { ...base.meta, requestBytes: raw.byteLength },
    request: {
      method: 'POST',
      path: '/v1/x',
      headers: [['content-type', 'application/json']],
      body: prepared,
    },
  };

  assertEquals(prepared.encoding, 'gzip');
  assertEquals(prepared.decodedByteLength, raw.byteLength);
  assertEquals(prepared.bytes.byteLength < raw.byteLength, true);
  await store.put('key_x', record);
  const fetched = await store.get('key_x', record.meta.id);
  assertExists(fetched);
  assertEquals(Array.from(fetched.request.body), Array.from(raw));
});

test('FileDumpStore round-trips a JSON record through gzip', async () => {
  const db = await openDb();
  const files = new MemoryFileStore();
  const store = new FileDumpStore(db, files);
  const record = baseRecord('01HZZ0000000000000000000A1', Date.UTC(2026, 5, 1, 12, 0, 0));

  await store.put('key_x', record);
  const fetched = await store.get('key_x', '01HZZ0000000000000000000A1');
  assertExists(fetched);
  assertEquals(fetched.meta.id, record.meta.id);
  assertEquals(new TextDecoder().decode(fetched.request.body), '{"hello":"world"}');
  if (fetched.response.body.type !== 'bytes') throw new Error('expected bytes');
  assertEquals(new TextDecoder().decode(fetched.response.body.body), '{"id":"abc"}');
});

test('FileDumpStore preserves the original content-type header on binary bodies', async () => {
  const db = await openDb();
  const files = new MemoryFileStore();
  const store = new FileDumpStore(db, files);
  const pngMagic = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const record: DumpWriteRecord = {
    ...baseRecord('01HZZ0000000000000000000PNG', Date.UTC(2026, 5, 1, 12, 0, 0)),
    response: {
      status: 200,
      headers: [['content-type', 'image/png']],
      body: { type: 'bytes', body: pngMagic },
    },
  };

  await store.put('key_x', record);
  const fetched = await store.get('key_x', '01HZZ0000000000000000000PNG');
  assertExists(fetched);
  // The header pair must survive verbatim — no `;base64` suffix tacked on.
  assertEquals(fetched.response.headers.find(([k]) => k === 'content-type')?.[1], 'image/png');
  if (fetched.response.body.type !== 'bytes') throw new Error('expected bytes');
  assertEquals(Array.from(fetched.response.body.body), Array.from(pngMagic));
});

test('FileDumpStore preserves the bytes discriminator on an empty-body response', async () => {
  const db = await openDb();
  const files = new MemoryFileStore();
  const store = new FileDumpStore(db, files);
  // 204-style: real upstream response with status + headers but a zero-length
  // body. Persistence drops the body file (nothing to gzip), but headers are
  // still written — the read path must surface this as `bytes`, not `none`.
  const record: DumpWriteRecord = {
    ...baseRecord('01HZZ0000000000000000000E1', Date.UTC(2026, 5, 1, 12, 0, 0)),
    response: {
      status: 204,
      headers: [['content-type', 'application/json']],
      body: { type: 'bytes', body: new Uint8Array() },
    },
  };

  await store.put('key_x', record);
  const fetched = await store.get('key_x', '01HZZ0000000000000000000E1');
  assertExists(fetched);
  if (fetched.response.body.type !== 'bytes') throw new Error('expected bytes');
  assertEquals(fetched.response.body.body.byteLength, 0);
  assertEquals(fetched.response.headers.find(([k]) => k === 'content-type')?.[1], 'application/json');
});

test('FileDumpStore round-trips an SSE record as a stream events array', async () => {
  const db = await openDb();
  const files = new MemoryFileStore();
  const store = new FileDumpStore(db, files);
  const record: DumpWriteRecord = {
    ...baseRecord('01HZZ0000000000000000000A2', Date.UTC(2026, 5, 1, 12, 0, 0)),
    response: {
      status: 200,
      headers: [['content-type', 'text/event-stream']],
      body: {
        type: 'stream',
        events: [
          { frame: { type: 'event', event: { type: 'message_start' } }, ts: 10 },
          { frame: { type: 'done' }, ts: 20 },
        ],
      },
    },
  };
  await store.put('key_x', record);
  const fetched = await store.get('key_x', '01HZZ0000000000000000000A2');
  assertExists(fetched);
  if (fetched.response.body.type !== 'stream') throw new Error('expected stream');
  assertEquals(fetched.response.body.events.length, 2);
  assertEquals(fetched.response.body.events[0]!.frame.type, 'event');
});

test('FileDumpStore rejects malformed metadata with its row identity', async () => {
  const db = await openDb();
  const store = new FileDumpStore(db, new MemoryFileStore());
  const record = baseRecord('01HZZ000000000000000000BADM', Date.UTC(2026, 5, 1, 12));
  await store.put('key_x', record);
  await db.prepare('UPDATE dump_records SET meta_json = ? WHERE key_id = ? AND id = ?')
    .bind(JSON.stringify({ ...record.meta, upstream: undefined, status: '200' }), 'key_x', record.meta.id)
    .run();

  await expect(store.list('key_x', { limit: 10 }))
    .rejects.toThrow(/Invalid dump record 01HZZ000000000000000000BADM metadata.*status/su);
});

test('FileDumpStore rejects malformed header pairs with their record and side', async () => {
  const db = await openDb();
  const store = new FileDumpStore(db, new MemoryFileStore());
  const record = baseRecord('01HZZ000000000000000000BADH', Date.UTC(2026, 5, 1, 12));
  await store.put('key_x', record);
  await db.prepare('UPDATE dump_records SET request_headers_json = ? WHERE key_id = ? AND id = ?')
    .bind(JSON.stringify([['x-bad', 1]]), 'key_x', record.meta.id)
    .run();

  await expect(store.get('key_x', record.meta.id))
    .rejects.toThrow(/Invalid dump record 01HZZ000000000000000000BADH request headers/u);
});

test('FileDumpStore rejects malformed body descriptors before file access', async () => {
  const db = await openDb();
  const store = new FileDumpStore(db, new MemoryFileStore());
  const record = baseRecord('01HZZ000000000000000000BADD', Date.UTC(2026, 5, 1, 12));
  await store.put('key_x', record);
  await db.prepare('UPDATE dump_records SET request_body_descriptor = ? WHERE key_id = ? AND id = ?')
    .bind(JSON.stringify({ key: 'dumps/v1/key_x/request.gz', type: 'chunks' }), 'key_x', record.meta.id)
    .run();

  await expect(store.get('key_x', record.meta.id))
    .rejects.toThrow(/Invalid dump record 01HZZ000000000000000000BADD request body descriptor.*type/su);
});

test('FileDumpStore rejects malformed stream events with record and file context', async () => {
  const db = await openDb();
  const files = new MemoryFileStore();
  const store = new FileDumpStore(db, files);
  const record: DumpWriteRecord = {
    ...baseRecord('01HZZ000000000000000000BADE', Date.UTC(2026, 5, 1, 12)),
    response: {
      status: 200,
      headers: [['content-type', 'text/event-stream']],
      body: { type: 'stream', events: [{ frame: { type: 'done' }, ts: 1 }] },
    },
  };
  await store.put('key_x', record);
  const row = await db.prepare('SELECT response_body_descriptor FROM dump_records WHERE key_id = ? AND id = ?')
    .bind('key_x', record.meta.id)
    .first<{ response_body_descriptor: string }>();
  if (row === null) throw new Error('expected stored dump row');
  const descriptor = decodeDumpBodyDescriptor(row.response_body_descriptor, 'test response descriptor');
  const malformedEvents = utf8(JSON.stringify([{ frame: { type: 'done' }, ts: 'late' }]));
  const compressed = new Uint8Array(await new Response(
    new Blob([malformedEvents as BlobPart]).stream().pipeThrough(new CompressionStream('gzip')),
  ).arrayBuffer());
  await files.put(descriptor.key, compressed);

  await expect(store.get('key_x', record.meta.id)).rejects.toThrow(
    new RegExp(`Invalid dump record ${record.meta.id} response events at key=${descriptor.key}.*ts`, 'su'),
  );
});

test('FileDumpStore.list paginates newest-first with the (createdAt, id) cursor', async () => {
  const db = await openDb();
  const files = new MemoryFileStore();
  const store = new FileDumpStore(db, files);
  const base = Date.UTC(2026, 5, 1, 12, 0, 0);
  for (let i = 0; i < 5; i++) {
    await store.put('key_x', baseRecord(`01HZZ000000000000000000A0${i}`, base + i));
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
  await store.put('key_x', baseRecord('01HZZ0000000000000000000A1', Date.UTC(2026, 5, 1, 9, 0, 0)));
  await store.put('key_x', baseRecord('01HZZ0000000000000000000A2', now));
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
  await store.put('key_x', baseRecord('01HZZ0000000000000000000A4', now - 3 * 3600_000));
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
  await store.put('key_x', baseRecord('01HZZ0000000000000000000A1', Date.UTC(2026, 5, 1, 9, 0, 0)));
  await store.put('key_x', baseRecord('01HZZ0000000000000000000A2', Date.UTC(2026, 5, 1, 12, 0, 0)));
  await repo.apiKeys.update('key_x', { dumpRetentionSeconds: null });
  assertEquals((await store.list('key_x', { limit: 10 })).length, 0);
  assertEquals(await store.deleteExpiredBatch('key_x', Date.now(), 100), 2);
  assertEquals((await db.prepare('SELECT COUNT(*) AS count FROM dump_records WHERE key_id = ?').bind('key_x').first<{ count: number }>())?.count, 0);
  await collectSpilledFiles(Date.now());
  assertEquals((await db.prepare('SELECT COUNT(*) AS count FROM spilled_files').first<{ count: number }>())?.count, 0);
});

test('a record-ID race leaves only the losing write\'s uniquely keyed files collectible', async () => {
  const db = await openDb();
  const repo = new SqlRepo(db);
  initRepo(repo);
  const files = new MemoryFileStore();
  initFileStore(files);
  const store = new FileDumpStore(db, files);
  const record = baseRecord('01HZZ0000000000000000000A3', Date.now());
  await store.put('key_x', record);

  await expect(store.put('key_x', record)).rejects.toThrow();
  expect((await db.prepare("SELECT COUNT(*) AS count FROM spilled_files WHERE state = 'owned'").first<{ count: number }>())?.count).toBe(2);
  expect((await db.prepare("SELECT COUNT(*) AS count FROM spilled_files WHERE state = 'staged'").first<{ count: number }>())?.count).toBe(2);

  await collectSpilledFiles(Date.now() + 60 * 60 * 1000 + 1);
  expect((await db.prepare("SELECT COUNT(*) AS count FROM spilled_files WHERE state = 'staged'").first<{ count: number }>())?.count).toBe(0);
  expect((await db.prepare("SELECT COUNT(*) AS count FROM spilled_files WHERE state = 'owned'").first<{ count: number }>())?.count).toBe(2);
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
    const record = baseRecord('01HZZ0000000000000000000A1', Date.UTC(2026, 5, 1, 12, 0, 0));

    await store.put('key_x', record);
    const fetched = await store.get('key_x', '01HZZ0000000000000000000A1');
    assertExists(fetched);
    assertEquals(new TextDecoder().decode(fetched.request.body), '{"hello":"world"}');
    if (fetched.response.body.type !== 'bytes') throw new Error('expected bytes');
    assertEquals(new TextDecoder().decode(fetched.response.body.body), '{"id":"abc"}');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
