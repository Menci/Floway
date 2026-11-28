import { expect, test, vi } from 'vitest';

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
    // Read-time join: the stored row's key wins over whatever the writer had.
    key: { id: 'writer-key', name: 'Writer key', suffix: 'writ' },
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
    const prepare = vi.spyOn(db, 'prepare');
    assertEquals(await store.deleteExpiredBatch('key_x', now + 1, 100), 1);
    const fallbackSql = prepare.mock.calls.at(-1)?.[0];
    prepare.mockRestore();
    assertExists(fallbackSql);
    const { results: fallbackPlan } = await db
      .prepare(`EXPLAIN QUERY PLAN ${fallbackSql}`)
      .bind('key_x', 'key_x', 99)
      .all<{ detail: string }>();
    expect(fallbackPlan.map(row => row.detail)).toEqual(expect.arrayContaining([
      expect.stringMatching(/^SCALAR SUBQUERY\b/),
      expect.stringContaining('SEARCH records USING COVERING INDEX idx_dump_records_key_created'),
    ]));
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
  await store.put('key_x', baseRecord('01HZZ0000000000000000000C1', Date.UTC(2026, 5, 1, 9)));
  await store.put('key_x', baseRecord('01HZZ0000000000000000000C2', Date.UTC(2026, 5, 1, 10)));
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
  await store.put('key_x', record);

  await expect(store.put('key_x', record)).rejects.toThrow();
  expect((await db.prepare("SELECT COUNT(*) AS count FROM spilled_files WHERE state = 'owned'").first<{ count: number }>())?.count).toBe(2);
  expect((await db.prepare("SELECT COUNT(*) AS count FROM spilled_files WHERE state = 'staged'").first<{ count: number }>())?.count).toBe(2);

  await collectSpilledFiles(Date.now() + 60 * 60 * 1000 + 1);
  expect((await db.prepare("SELECT COUNT(*) AS count FROM spilled_files WHERE state = 'staged'").first<{ count: number }>())?.count).toBe(0);
  expect((await db.prepare("SELECT COUNT(*) AS count FROM spilled_files WHERE state = 'owned'").first<{ count: number }>())?.count).toBe(2);
  assertExists(await store.get('key_x', record.meta.id));
});

test('FileDumpStore round-trips raw exchanges and parsed events in one owned spill', async () => {
  const db = await openDb();
  const files = new MemoryFileStore();
  const store = new FileDumpStore(db, files);
  const record = baseRecord('raw-exchange', Date.now());
  record.capture = {
    exchanges: [{ upstreamId: 'u', request: { url: 'https://u.test', method: 'POST', headers: [], body: { encoding: 'utf8', data: '{"model":"upstream"}' } }, response: { status: 200, headers: [['content-type', 'text/event-stream']], body: { encoding: 'utf8', data: 'data: {broken\n' }, complete: false, error: 'socket reset' }, error: null }],
    response: { body: { encoding: 'utf8', data: 'downstream' }, complete: true, error: null },
  };
  record.response = { ...record.response, upstream: { status: 200, headers: [['x-trace', 'upstream']], body: { type: 'stream', events: [{ ts: 0, frame: { type: 'done' } }] } } };
  await store.put('key_x', record);
  const stored = await store.get('key_x', record.meta.id);
  expect(stored?.capture).toEqual(record.capture);
  expect(stored?.response.upstream).toEqual(record.response.upstream);
  const spill = await db.prepare("SELECT file_key, state FROM spilled_files WHERE owner_kind = 'dump-response-upstream'").first<{ file_key: string; state: string }>();
  expect(spill?.state).toBe('owned');
  await db.prepare('DELETE FROM dump_records WHERE id = ?').bind(record.meta.id).run();
  expect((await db.prepare('SELECT state FROM spilled_files WHERE file_key = ?').bind(spill!.file_key).first<{ state: string }>())?.state).toBe('retired');
});

test('FileDumpStore filters all retained history before applying the page limit', async () => {
  const db = await openDb();
  const store = new FileDumpStore(db, new MemoryFileStore());
  const now = Date.now();
  for (let i = 0; i < 5; i++) {
    const record = baseRecord(`filter-${i}`, now - i);
    record.meta.model = i === 4 ? 'needle-model' : 'other';
    record.meta.error = i === 4 ? { kind: 'failed', reason: 'socket reset' } : null;
    await store.put('key_x', record);
  }
  expect((await store.list('key_x', { q: 'needle', limit: 1 })).map(meta => meta.id)).toEqual(['filter-4']);
  expect((await store.list('key_x', { q: 'SOCKET', failures: true, limit: 1 })).map(meta => meta.id)).toEqual(['filter-4']);
  expect(await store.list('key_x', { q: "' OR 1=1 --", limit: 1 })).toEqual([]);
  expect(await store.list('other-key', { q: 'needle', limit: 1 })).toEqual([]);
});

const saveSecondKey = async (db: SqlDatabase, overrides: { id: string; name: string; key: string }): Promise<void> => {
  await new SqlRepo(db).apiKeys.save({
    userId: 1,
    serverSecret: '66'.repeat(32),
    createdAt: '2026-01-01T00:00:00.000Z',
    upstreamIds: null,
    randomizeUpstreams: false,
    deletedAt: null,
    dumpRetentionSeconds: 10 * 365 * 24 * 60 * 60,
    openaiResponsesRetentionSeconds: 0,
    ...overrides,
  });
};

test('FileDumpStore merges a page across keys and hydrates each source key', async () => {
  const db = await openDb();
  await saveSecondKey(db, { id: 'key_y', name: 'Second key', key: 'raw-second-key' });
  const store = new FileDumpStore(db, new MemoryFileStore());
  const first = baseRecord('01HZZ0000000000000000000M1', Date.UTC(2026, 5, 1, 12, 0, 0));
  const second = baseRecord('01HZZ0000000000000000000M2', Date.UTC(2026, 5, 1, 13, 0, 0));
  await store.put('key_x', first);
  await store.put('key_y', second);

  const page = await store.listAll(['key_x', 'key_y'], { limit: 10 });
  assertEquals(page.map(meta => meta.id), ['01HZZ0000000000000000000M2', '01HZZ0000000000000000000M1']);
  // The suffix is the raw key's last four characters; the key itself never
  // reaches the metadata.
  assertEquals(page[0]!.key, { id: 'key_y', name: 'Second key', suffix: '-key' });
  assertEquals(page[1]!.key, { id: 'key_x', name: 'Dump key', suffix: '-key' });
  assertEquals('meta_json' in page[0]!, false);
});

test('FileDumpStore pages a merged log across keys with one global cursor', async () => {
  const db = await openDb();
  await saveSecondKey(db, { id: 'key_y', name: 'Second key', key: 'raw-second-key' });
  const store = new FileDumpStore(db, new MemoryFileStore());
  const older = baseRecord('01HZZ0000000000000000000N1', Date.UTC(2026, 5, 1, 10, 0, 0));
  const middle = baseRecord('01HZZ0000000000000000000N2', Date.UTC(2026, 5, 1, 11, 0, 0));
  const newest = baseRecord('01HZZ0000000000000000000N3', Date.UTC(2026, 5, 1, 12, 0, 0));
  await store.put('key_x', older);
  await store.put('key_y', middle);
  await store.put('key_x', newest);

  assertEquals((await store.listAll(['key_x', 'key_y'], { limit: 10 })).map(meta => meta.id), [newest.meta.id, middle.meta.id, older.meta.id]);
  assertEquals((await store.listAll(['key_x', 'key_y'], { before: middle.meta.id, limit: 10 })).map(meta => meta.id), [older.meta.id]);
  assertEquals(await store.listAll([], { limit: 10 }), []);
});

test('FileDumpStore merges every key page in order when each key overflows one page', async () => {
  const db = await openDb();
  await saveSecondKey(db, { id: 'key_y', name: 'Second key', key: 'raw-second-key' });
  const store = new FileDumpStore(db, new MemoryFileStore());
  // Two keys interleaved across four timestamps: every timestamp is shared, so
  // the id descending is the only thing that can order each pair, and its order
  // is deliberately not the write order. Limit 3 with four rows per key means
  // each key's own page is cut short and only the merge can be complete.
  const base = Date.UTC(2026, 5, 1, 12, 0, 0);
  const rows = [
    { id: '01HZZ0000000000000000000C0', at: 0, keyId: 'key_x' },
    { id: '01HZZ0000000000000000000C7', at: 0, keyId: 'key_y' },
    { id: '01HZZ0000000000000000000C1', at: 1, keyId: 'key_x' },
    { id: '01HZZ0000000000000000000C6', at: 1, keyId: 'key_y' },
    { id: '01HZZ0000000000000000000C2', at: 2, keyId: 'key_x' },
    { id: '01HZZ0000000000000000000C5', at: 2, keyId: 'key_y' },
    { id: '01HZZ0000000000000000000C3', at: 3, keyId: 'key_x' },
    { id: '01HZZ0000000000000000000C4', at: 3, keyId: 'key_y' },
  ];
  for (const row of rows) await store.put(row.keyId, baseRecord(row.id, base + row.at));
  const all = [
    '01HZZ0000000000000000000C4', '01HZZ0000000000000000000C3',
    '01HZZ0000000000000000000C5', '01HZZ0000000000000000000C2',
    '01HZZ0000000000000000000C6', '01HZZ0000000000000000000C1',
    '01HZZ0000000000000000000C7', '01HZZ0000000000000000000C0',
  ];

  const paged: string[] = [];
  let before: string | undefined;
  for (;;) {
    const page = await store.listAll(['key_x', 'key_y'], { limit: 3, ...(before === undefined ? {} : { before }) });
    paged.push(...page.map(meta => meta.id));
    if (page.length < 3) break;
    before = page.at(-1)!.id;
  }

  assertEquals(paged, all);
});

test('FileDumpStore drops a key\'s records from the merged page once it loses retention or is deleted', async () => {
  const db = await openDb();
  const repo = new SqlRepo(db);
  await saveSecondKey(db, { id: 'key_y', name: 'Second key', key: 'raw-second-key' });
  const store = new FileDumpStore(db, new MemoryFileStore());
  const fromX = baseRecord('01HZZ0000000000000000000R1', Date.UTC(2026, 5, 1, 10, 0, 0));
  const fromY = baseRecord('01HZZ0000000000000000000R2', Date.UTC(2026, 5, 1, 11, 0, 0));
  await store.put('key_x', fromX);
  await store.put('key_y', fromY);

  assertEquals((await store.listAll(['key_x', 'key_y'], { limit: 10 })).map(meta => meta.id), [fromY.meta.id, fromX.meta.id]);
  await repo.apiKeys.update('key_y', { dumpRetentionSeconds: null });
  assertEquals((await store.listAll(['key_x', 'key_y'], { limit: 10 })).map(meta => meta.id), [fromX.meta.id]);

  await repo.apiKeys.update('key_x', { dumpRetentionSeconds: null });
  await repo.apiKeys.softDelete('key_x');
  assertEquals(await store.listAll(['key_x'], { limit: 10 }), []);
});

test('FileDumpStore returns an empty merged page when the cursor names another scope\'s record', async () => {
  const db = await openDb();
  await saveSecondKey(db, { id: 'key_y', name: 'Second key', key: 'raw-second-key' });
  const store = new FileDumpStore(db, new MemoryFileStore());
  const mine = baseRecord('01HZZ0000000000000000000B1', Date.UTC(2026, 5, 1, 10, 0, 0));
  await store.put('key_x', mine);

  assertEquals(await store.listAll(['key_y'], { before: mine.meta.id, limit: 10 }), []);
});

test('FileDumpStore resolves a record from any of the operator keys and shows its owning key', async () => {
  const db = await openDb();
  await saveSecondKey(db, { id: 'key_y', name: 'Second key', key: 'raw-second-key' });
  const store = new FileDumpStore(db, new MemoryFileStore());
  const record = baseRecord('01HZZ0000000000000000000G1', Date.UTC(2026, 5, 1, 12, 0, 0));
  await store.put('key_y', record);

  const fetched = await store.getAny(['key_x', 'key_y'], record.meta.id);
  assertExists(fetched);
  assertEquals(fetched.meta.key, { id: 'key_y', name: 'Second key', suffix: '-key' });
  assertEquals(await store.getAny(['key_x'], record.meta.id), null);
  assertEquals(await store.getAny([], record.meta.id), null);
});

test('FileDumpStore applies one search to the merged page and the single-key page', async () => {
  const db = await openDb();
  await saveSecondKey(db, { id: 'key_y', name: 'Second key', key: 'raw-second-key' });
  const store = new FileDumpStore(db, new MemoryFileStore());
  const hit = baseRecord('01HZZ0000000000000000000S1', Date.UTC(2026, 5, 1, 10, 0, 0));
  hit.meta.model = 'needle-model';
  const miss = baseRecord('01HZZ0000000000000000000S2', Date.UTC(2026, 5, 1, 11, 0, 0));
  await store.put('key_x', hit);
  await store.put('key_y', miss);

  assertEquals((await store.listAll(['key_x', 'key_y'], { q: 'needle', limit: 10 })).map(meta => meta.id), [hit.meta.id]);
  assertEquals((await store.list('key_x', { q: 'needle', limit: 10 })).map(meta => meta.id), [hit.meta.id]);
  // The key name is searchable on both sides; the suffix is not.
  assertEquals((await store.listAll(['key_x', 'key_y'], { q: 'second', limit: 10 })).map(meta => meta.id), [miss.meta.id]);
  assertEquals(await store.listAll(['key_x', 'key_y'], { q: '-key', limit: 10 }), []);
});
