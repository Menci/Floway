import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { test } from 'vitest';

import { FileDumpStore } from './dump-store.ts';
import type { DumpWriteRecord } from '../dump/types.ts';
import { MemoryFileProvider } from '@floway-dev/platform';
import type { FileProvider, SqlDatabase, SqlPreparedStatement, SqlResult } from '@floway-dev/platform';
import { assertEquals, assertExists } from '@floway-dev/test-utils';

// Thin SqlDatabase adapter over node:sqlite's DatabaseSync, kept inside the
// test file because the production gateway core never needs it — node-only
// production code lives in apps/platform-node. Mirrors the shape of the
// Node app's wrapper just enough to back the dump-store schema.
//
// `dump_records` LEFT JOINs `upstreams` to resolve each row's current
// upstream name, kind, and color at read time. The test schema therefore
// needs both tables present; we synthesise a minimal `upstreams` shape
// (only the columns the join reads) so the test stays decoupled from
// the full production upstreams migration.
const MIGRATION_PATH = resolve(fileURLToPath(import.meta.url), '..', '..', '..', 'migrations', '0041_dump_records.sql');
const UPSTREAMS_STUB_SQL = `
  CREATE TABLE upstreams (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    color TEXT NULL
  );
`;

const openDb = async (): Promise<SqlDatabase> => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(UPSTREAMS_STUB_SQL);
  sqlite.exec(await readFile(MIGRATION_PATH, 'utf8'));
  return {
    prepare(query): SqlPreparedStatement {
      const stmt = sqlite.prepare(query);
      const make = (bound: unknown[]): SqlPreparedStatement => ({
        bind(...values) { return make(values); },
        first: async <T = Record<string, unknown>>() =>
          (stmt.get(...bound as never[]) as T | undefined) ?? null,
        all: async <T = Record<string, unknown>>() => ({
          results: stmt.all(...bound as never[]) as T[],
          success: true,
          meta: {},
        } satisfies SqlResult<T>),
        run: async () => {
          const r = stmt.run(...bound as never[]);
          return { results: [], success: true, meta: { changes: Number(r.changes) } } satisfies SqlResult;
        },
      });
      return make([]);
    },
    exec: async sql => { sqlite.exec(sql); },
  };
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
  const files = new MemoryFileProvider();
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
  const files = new MemoryFileProvider();
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
  const files = new MemoryFileProvider();
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
  const files = new MemoryFileProvider();
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
  const files = new MemoryFileProvider();
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

test('FileDumpStore.list paginates newest-first with the (createdAt, id) cursor', async () => {
  const db = await openDb();
  const files = new MemoryFileProvider();
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

test('FileDumpStore.purgeExpired drops rows past the cutoff and sweeps whole hour buckets', async () => {
  const db = await openDb();
  const files = new MemoryFileProvider();
  const store = new FileDumpStore(db, files);
  const now = Date.UTC(2026, 5, 1, 12, 0, 0);
  // Old bucket 9:xx, current bucket 12:xx.
  await store.put('key_x', baseRecord('01HZZ0000000000000000000A1', Date.UTC(2026, 5, 1, 9, 0, 0)));
  await store.put('key_x', baseRecord('01HZZ0000000000000000000A2', now));
  // 2 hours retention; the old bucket is past the cutoff and should disappear,
  // but the now bucket must stay because its end is still within the window.
  const originalNow = Date.now;
  Date.now = () => now + 1;
  try {
    await store.purgeExpired('key_x', 2 * 3600);
  } finally {
    Date.now = originalNow;
  }
  const left = await store.list('key_x', { limit: 10 });
  assertEquals(left.map(m => m.id), ['01HZZ0000000000000000000A2']);

  const remainingFiles = await files.listKeys('dumps/v1/key_x/');
  assertEquals(remainingFiles.every(k => !k.includes('2026060109')), true);
});

test('FileDumpStore.purgeAll wipes every row and every file under the key prefix', async () => {
  const db = await openDb();
  const files = new MemoryFileProvider();
  const store = new FileDumpStore(db, files);
  await store.put('key_x', baseRecord('01HZZ0000000000000000000A1', Date.UTC(2026, 5, 1, 9, 0, 0)));
  await store.put('key_x', baseRecord('01HZZ0000000000000000000A2', Date.UTC(2026, 5, 1, 12, 0, 0)));
  await store.purgeAll('key_x');
  assertEquals((await store.list('key_x', { limit: 10 })).length, 0);
  assertEquals((await files.listKeys('dumps/v1/key_x/')).length, 0);
});

test('FileDumpStore.purgeExpired against a never-written key resolves without throwing', async () => {
  const db = await openDb();
  const files = new MemoryFileProvider();
  const store = new FileDumpStore(db, files);
  await store.purgeExpired('never_written_key', 3600);
  assertEquals((await store.list('never_written_key', { limit: 10 })).length, 0);
  assertEquals((await files.listKeys('dumps/v1/never_written_key/')).length, 0);
});

// Smoke test: drive FileDumpStore against a real-filesystem FileProvider so a
// regression where the store leans on MemoryFileProvider's stricter ordering /
// instant durability surfaces here. The inline FileProvider mirrors the shape
// of the Node platform-target app's `FsFileProvider` — keeping this test in
// gateway, not in apps/platform-node, is what lets that app's src/ tree stay
// free of business-domain knowledge.
class TmpDirFileProvider implements FileProvider {
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
  async deletePrefix(prefix: string): Promise<void> {
    if (prefix === '') throw new Error('refusing empty prefix');
    await rm(this.pathFor(prefix), { recursive: true, force: true });
  }
  async listKeys(prefix: string): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(this.pathFor(prefix), { withFileTypes: true, recursive: true });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return [];
      throw e;
    }
    const out: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      out.push(relative(this.root, join(entry.parentPath, entry.name)).split(sep).join('/'));
    }
    return out;
  }
  private pathFor(key: string): string {
    return resolve(this.root, ...key.split('/'));
  }
}

test('FileDumpStore: put + get round-trips through real-filesystem IO + node:sqlite', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dump-store-'));
  try {
    const db = await openDb();
    const store = new FileDumpStore(db, new TmpDirFileProvider(join(root, 'files')));
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
