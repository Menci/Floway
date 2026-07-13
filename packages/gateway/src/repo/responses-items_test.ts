import initSqlJs from 'sql.js';
import { test, vi } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { storedResponsesItemMetadata } from './responses-clone.ts';
import { SqlRepo } from './sql.ts';
import type { ResponsesItemsRepo, StoredResponsesItem } from './types.ts';
import { initFileProvider, MemoryFileProvider, sha256Hex, type FileProvider, type SqlDatabase } from '@floway-dev/platform';
import { assert, assertEquals, assertRejects } from '@floway-dev/test-utils';

// `refreshMany` debounces writes within a 24h window, so refresh-related
// assertions need timestamps that span more than a day to actually exercise
// the update path. Scaling every numeric timestamp by DAY_MS keeps the
// existing assertions ordering and arithmetic intact while making refresh
// gaps comfortably exceed the debounce.
const DAY_MS = 24 * 60 * 60 * 1000;

// gzip flattens long runs of a single character almost to nothing; spill tests
// need a body that resists compression so it actually crosses the inline
// threshold.
const incompressibleString = (approxBytes: number): string => {
  const bytes = new Uint8Array(Math.ceil(approxBytes / 2));
  crypto.getRandomValues(bytes);
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex.slice(0, approxBytes);
};

const storedItem = (overrides: Partial<StoredResponsesItem> & Pick<StoredResponsesItem, 'id' | 'apiKeyId' | 'createdAt'>): StoredResponsesItem => ({
  upstreamId: null,
  upstreamItemId: null,
  itemType: 'message',
  origin: 'upstream',
  contentHash: null,
  encryptedContentHash: null,
  payload: { item: { id: overrides.id, type: 'message', content: [{ type: 'output_text', text: overrides.id }] } },
  refreshedAt: overrides.createdAt,
  ...overrides,
});

const createDeferred = <T>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
};

class GatedReadFileProvider implements FileProvider {
  private readonly bodies = new Map<string, Uint8Array>();
  private readonly firstGet = createDeferred<void>();
  private readonly release = createDeferred<void>();
  private released = false;
  getCalls = 0;

  put(key: string, body: Uint8Array): Promise<void> {
    this.bodies.set(key, body.slice());
    return Promise.resolve();
  }

  async get(key: string): Promise<Uint8Array | null> {
    this.getCalls++;
    this.firstGet.resolve();
    if (!this.released) await this.release.promise;
    return this.bodies.get(key)?.slice() ?? null;
  }

  deletePrefix(prefix: string): Promise<void> {
    for (const key of this.bodies.keys()) {
      if (key.startsWith(prefix)) this.bodies.delete(key);
    }
    return Promise.resolve();
  }

  listKeys(prefix: string): Promise<string[]> {
    return Promise.resolve([...this.bodies.keys()].filter(key => key.startsWith(prefix)));
  }

  waitForFirstGet(): Promise<void> {
    return this.firstGet.promise;
  }

  releaseAll(): void {
    this.released = true;
    this.release.resolve();
  }
}

const runWithCompressionBlocked = async <T>(run: () => Promise<T>): Promise<{ started: number; result: T }> => {
  const NativeCompressionStream = globalThis.CompressionStream;
  const release = createDeferred<void>();
  let started = 0;

  class GatedCompressionStream {
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable: WritableStream<BufferSource>;

    constructor(format: CompressionFormat) {
      started++;
      const native = new NativeCompressionStream(format);
      const writer = native.writable.getWriter();
      this.readable = native.readable;
      this.writable = new WritableStream<BufferSource>({
        async write(chunk) {
          await release.promise;
          await writer.write(chunk);
        },
        async close() { await writer.close(); },
        async abort(reason) { await writer.abort(reason); },
      });
    }
  }

  vi.stubGlobal('CompressionStream', GatedCompressionStream);
  try {
    const pending = run();
    const startedBeforeRelease = started;
    release.resolve();
    return { started: startedBeforeRelease, result: await pending };
  } finally {
    vi.unstubAllGlobals();
  }
};

const exerciseResponsesItemsRepo = async (repo: ResponsesItemsRepo) => {
  initFileProvider(new MemoryFileProvider());
  const first = storedItem({
    id: 'msg_z1mVjw_0xVvS8c_KjD1sBkZk5qbdA',
    apiKeyId: 'key_a',
    upstreamId: 'up_azure',
    upstreamItemId: 'upstream_msg_a',
    itemType: 'message',
    contentHash: 'content_hash_a',
    createdAt: 1_000 * DAY_MS,
  });
  const second = storedItem({
    id: 'rs_mFBDiA_Lh1uXb7nD_bQb4I1CUYH2w',
    apiKeyId: 'key_a',
    upstreamId: 'up_copilot',
    upstreamItemId: 'opaque_reasoning_id',
    itemType: 'reasoning',
    payload: { item: { id: 'rs_mFBDiA_Lh1uXb7nD_bQb4I1CUYH2w', type: 'reasoning', summary: [] } },
    createdAt: 2_000 * DAY_MS,
  });
  const adminScoped = storedItem({
    id: 'ws_WGRXTA_sVlhxg6BAV0BUzj0KkWSqA',
    apiKeyId: null,
    itemType: 'web_search_call',
    payload: { item: { id: 'ws_WGRXTA_sVlhxg6BAV0BUzj0KkWSqA', type: 'web_search_call', status: 'completed' } },
    createdAt: 3_000 * DAY_MS,
  });

  await repo.insertMany([first, second, adminScoped]);

  assertEquals(await repo.lookupMany('key_a', [second.id, adminScoped.id, first.id, 'missing']), [second, first].map(storedResponsesItemMetadata));
  assertEquals(await repo.lookupMany(null, [first.id, adminScoped.id]), [storedResponsesItemMetadata(adminScoped)]);
  assertEquals(await repo.lookupMany('key_b', [first.id, second.id, adminScoped.id]), []);
  assertEquals(await repo.lookupMany('key_a', []), []);
  assertEquals(await repo.lookupManyByContentHash('key_a', ['content_hash_a']), [storedResponsesItemMetadata(first)]);
  assertEquals(await repo.lookupManyByContentHash('key_b', ['content_hash_a']), []);

  assertEquals(await repo.refreshMany('key_a', [first.id, first.id, second.id, adminScoped.id, 'missing'], 4_000 * DAY_MS), 2);
  assertEquals(
    await repo.lookupMany('key_a', [first.id, second.id]),
    [
      { ...first, refreshedAt: 4_000 * DAY_MS },
      { ...second, refreshedAt: 4_000 * DAY_MS },
    ].map(storedResponsesItemMetadata),
  );
  // Smaller-than-stored refreshedAt: rejected for two overlapping reasons —
  // the never-go-backwards guard, and (since 3_500*DAY < 4_000*DAY - debounce)
  // the debounce. Both block, so this assertion holds regardless of which
  // fires first. The dedicated debounce test below isolates the boundary.
  assertEquals(await repo.refreshMany('key_a', [first.id], 3_500 * DAY_MS), 0);
  assertEquals(await repo.refreshMany(null, [adminScoped.id], 5_000 * DAY_MS), 1);
  const refreshedAdminScoped = { ...adminScoped, refreshedAt: 5_000 * DAY_MS };

  assertEquals(await repo.clearPayloadOlderThan(500 * DAY_MS), 0);
  assertEquals(await repo.clearPayloadOlderThan(2_500 * DAY_MS), 2);
  assertEquals(
    await repo.lookupMany('key_a', [first.id, second.id]),
    [
      { ...first, payload: null, refreshedAt: 4_000 * DAY_MS },
      { ...second, payload: null, refreshedAt: 4_000 * DAY_MS },
    ].map(storedResponsesItemMetadata),
  );
  assertEquals(await repo.lookupMany(null, [adminScoped.id]), [storedResponsesItemMetadata(refreshedAdminScoped)]);

  assertEquals(await repo.deleteOlderThan(3_000 * DAY_MS), 0);
  assertEquals(await repo.deleteOlderThan(4_500 * DAY_MS), 2);
  assertEquals(await repo.lookupMany('key_a', [first.id, second.id]), []);
  assertEquals(await repo.lookupMany(null, [adminScoped.id]), [storedResponsesItemMetadata(refreshedAdminScoped)]);

  await repo.deleteAll();
  assertEquals(await repo.lookupMany(null, [adminScoped.id]), []);
};

test('memory responses items repo inserts, looks up by scope, cleans payloads, deletes rows, and clears', async () => {
  await exerciseResponsesItemsRepo(new InMemoryRepo().responsesItems);
});

const exerciseRefreshManyDebounce = async (repo: ResponsesItemsRepo) => {
  initFileProvider(new MemoryFileProvider());
  const base = Date.UTC(2026, 0, 1);
  const item = storedItem({
    id: 'msg_z1mVjw_0xVvS8c_KjD1sBkZk5qbdA',
    apiKeyId: 'key_a',
    createdAt: base,
  });
  await repo.insertMany([item]);

  // First touch lifts refreshed_at into the future, where it'll act as the
  // anchor every subsequent attempt is measured against.
  assertEquals(await repo.refreshMany('key_a', [item.id], base + 30 * DAY_MS), 1);

  // Within the 24h debounce window the row shouldn't change.
  assertEquals(await repo.refreshMany('key_a', [item.id], base + 30 * DAY_MS + 12 * 60 * 60 * 1000), 0);
  assertEquals(await repo.refreshMany('key_a', [item.id], base + 31 * DAY_MS - 1), 0);
  // Right at the window boundary the cutoff equals refreshed_at, still no
  // update because the comparison is strictly less-than.
  assertEquals(await repo.refreshMany('key_a', [item.id], base + 31 * DAY_MS), 0);
  assertEquals((await repo.lookupMany('key_a', [item.id]))[0].refreshedAt, base + 30 * DAY_MS);

  // Past the window the row advances.
  assertEquals(await repo.refreshMany('key_a', [item.id], base + 31 * DAY_MS + 1), 1);
  assertEquals((await repo.lookupMany('key_a', [item.id]))[0].refreshedAt, base + 31 * DAY_MS + 1);
};

test('memory responses items refreshMany debounces writes within 24h', async () => {
  await exerciseRefreshManyDebounce(new InMemoryRepo().responsesItems);
});

test('SQL responses items refreshMany debounces writes within 24h', async () => {
  await exerciseRefreshManyDebounce(new SqlRepo(new FakeResponsesItemsSqlDatabase()).responsesItems);
});

test('memory responses snapshots refresh debounces writes within 24h', async () => {
  const repo = new InMemoryRepo().responsesSnapshots;
  const base = Date.UTC(2026, 0, 1);
  await repo.insert({
    id: 'resp_dbnc',
    apiKeyId: 'key_a',
    itemIds: ['msg_a'],
    createdAt: base,
    refreshedAt: base,
  });

  assertEquals(await repo.refresh('key_a', 'resp_dbnc', base + 30 * DAY_MS), true);
  assertEquals(await repo.refresh('key_a', 'resp_dbnc', base + 30 * DAY_MS + 12 * 60 * 60 * 1000), false);
  assertEquals(await repo.refresh('key_a', 'resp_dbnc', base + 31 * DAY_MS), false);
  assertEquals(await repo.refresh('key_a', 'resp_dbnc', base + 31 * DAY_MS + 1), true);
  assertEquals((await repo.lookup('key_a', 'resp_dbnc'))?.refreshedAt, base + 31 * DAY_MS + 1);
});

test('memory responses items repo clones item JSON at the repo boundary', async () => {
  const repo = new InMemoryRepo().responsesItems;
  const item = storedItem({
    id: 'msg_z1mVjw_0xVvS8c_KjD1sBkZk5qbdA',
    apiKeyId: 'key_a',
    payload: { item: { nested: { values: ['original'] } } },
    createdAt: 1_000,
  });

  await repo.insertMany([item]);
  (item.payload!.item as { nested: { values: string[] } }).nested.values.push('mutated-after-write');

  const [metadata] = await repo.lookupMany('key_a', [item.id]);
  const [read] = await repo.lookupPayloads('key_a', [item.id]);
  assertEquals(metadata.hasPayload, true);
  assertEquals(read.payload, { item: { nested: { values: ['original'] } } });
  (read.payload.item as { nested: { values: string[] } }).nested.values.push('mutated-after-read');

  assertEquals((await repo.lookupPayloads('key_a', [item.id]))[0].payload, { item: { nested: { values: ['original'] } } });
});

test('memory responses items repo scopes ids by api key and treats duplicate scoped writes as no-ops', async () => {
  const repo = new InMemoryRepo().responsesItems;
  const item = storedItem({ id: 'msg_z1mVjw_0xVvS8c_KjD1sBkZk5qbdA', apiKeyId: 'key_a', createdAt: 1_000 });
  await repo.insertMany([item]);
  await repo.insertMany([
    { ...item, apiKeyId: 'key_b' },
    { ...item, payload: { item: { changed: true } }, createdAt: 2_000 },
  ]);

  // Same scope: the duplicate insert is a no-op; row reflects the first
  // write. Stored ids use random bodies, so colliding writes only happen
  // within one stream's mapper retries, which the wrap dedupes upstream.
  assertEquals(await repo.lookupMany('key_a', [item.id]), [storedResponsesItemMetadata(item)]);
  // Different scope: a parallel row is created.
  assertEquals(await repo.lookupMany('key_b', [item.id]), [storedResponsesItemMetadata({ ...item, apiKeyId: 'key_b' })]);
});

const exerciseResponsesItemsRepoPayloadFill = async (repo: ResponsesItemsRepo) => {
  initFileProvider(new MemoryFileProvider());
  const metadata = storedItem({
    id: 'msg_z1mVjw_0xVvS8c_KjD1sBkZk5qbdA',
    apiKeyId: 'key_a',
    upstreamId: 'up_responses',
    upstreamItemId: 'upstream_msg',
    payload: null,
    createdAt: 1_000,
  });
  const filled = {
    ...metadata,
    payload: { item: { type: 'message', id: metadata.id, role: 'user', content: 'captured later' } },
    contentHash: 'content_hash_later',
    encryptedContentHash: 'encrypted_content_hash_later',
    createdAt: 2_000,
    refreshedAt: 2_000,
  } satisfies StoredResponsesItem;

  await repo.insertMany([metadata]);

  assertEquals(await repo.fillPayloads([filled]), 1);
  assertEquals(await repo.lookupMany('key_a', [metadata.id]), [storedResponsesItemMetadata(filled)]);
  assertEquals(await repo.fillPayloads([{ ...filled, payload: { item: { changed: true } }, createdAt: 3_000, refreshedAt: 3_000 }]), 0);
  assertEquals(await repo.lookupMany('key_a', [metadata.id]), [storedResponsesItemMetadata(filled)]);
};

test('memory responses items repo fills metadata-only payloads once', async () => {
  await exerciseResponsesItemsRepoPayloadFill(new InMemoryRepo().responsesItems);
});

test('SQL responses items repo inserts, looks up by scope, cleans payloads, deletes rows, and clears', async () => {
  await exerciseResponsesItemsRepo(new SqlRepo(new FakeResponsesItemsSqlDatabase()).responsesItems);
});

test('SQL responses items repo rejects malformed stored payload_json', async () => {
  const db = new FakeResponsesItemsSqlDatabase();
  db.rows.push({
    id: 'msg_z1mVjw_0xVvS8c_KjD1sBkZk5qbdA',
    api_key_id: 'key_a',
    upstream_id: null,
    upstream_item_id: null,
    item_type: 'message',
    origin: 'synthetic',
    payload_json: '{bad json',
    content_hash: null,
    encrypted_content_hash: null,
    created_at: 1_000,
    refreshed_at: 1_000,
  });

  const repo = new SqlRepo(db).responsesItems;
  const [metadata] = await repo.lookupMany('key_a', ['msg_z1mVjw_0xVvS8c_KjD1sBkZk5qbdA']);
  assertEquals(metadata.hasPayload, true);
  await assertRejects(() => repo.lookupPayloads('key_a', [metadata.id]), Error, 'Malformed responses_items.payload_json JSON');
});

test('SQL responses items repo scopes ids by api key and treats duplicate scoped writes as no-ops', async () => {
  const repo = new SqlRepo(new FakeResponsesItemsSqlDatabase()).responsesItems;
  const item = storedItem({ id: 'msg_z1mVjw_0xVvS8c_KjD1sBkZk5qbdA', apiKeyId: 'key_a', createdAt: 1_000 });
  await repo.insertMany([item]);
  await repo.insertMany([
    { ...item, apiKeyId: 'key_b' },
    { ...item, payload: { item: { changed: true } }, createdAt: 2_000 },
  ]);

  assertEquals(await repo.lookupMany('key_a', [item.id]), [storedResponsesItemMetadata(item)]);
  assertEquals(await repo.lookupMany('key_b', [item.id]), [storedResponsesItemMetadata({ ...item, apiKeyId: 'key_b' })]);
});

test('SQL responses items repo fills metadata-only payloads once', async () => {
  await exerciseResponsesItemsRepoPayloadFill(new SqlRepo(new FakeResponsesItemsSqlDatabase()).responsesItems);
});

test('SQL responses items repo chunks lookups exceeding the 100-parameter limit and unions the results', async () => {
  const repo = new SqlRepo(new FakeResponsesItemsSqlDatabase()).responsesItems;
  const items = Array.from({ length: 200 }, (_, i) =>
    storedItem({ id: `msg_chunk_${i.toString().padStart(4, '0')}`, apiKeyId: 'key_a', encryptedContentHash: `enc_${i}`, createdAt: 1_000 + i }));
  await repo.insertMany(items);

  const byId = await repo.lookupMany('key_a', items.map(item => item.id));
  assertEquals(byId.map(row => row.id), items.map(item => item.id));

  const byHash = await repo.lookupManyByEncryptedContentHash('key_a', items.map(item => item.encryptedContentHash!));
  assertEquals(new Set(byHash.map(row => row.id)).size, 200);
});

test('SQL responses items repo hydrates one payload at a time across query chunks', async () => {
  const db = new FakeResponsesItemsSqlDatabase();
  const files = new GatedReadFileProvider();
  initFileProvider(files);
  const ids: string[] = [];
  const encoder = new TextEncoder();
  for (let index = 0; index < 91; index++) {
    const id = `msg_codec_${index.toString().padStart(3, '0')}`;
    const key = `codec/${id}.json`;
    const body = encoder.encode(JSON.stringify({ item: { type: 'message', id, role: 'assistant', content: `payload ${index}` } }));
    await files.put(key, body);
    db.rows.push({
      id,
      api_key_id: 'key_a',
      upstream_id: 'up_a',
      upstream_item_id: `raw_${index}`,
      item_type: 'message',
      origin: 'upstream',
      payload_json: JSON.stringify({ version: 1, storage: 'file', key, sha256: await sha256Hex(body), byteLength: body.byteLength }),
      content_hash: null,
      encrypted_content_hash: null,
      created_at: index,
      refreshed_at: index,
    });
    ids.push(id);
  }
  const repo = new SqlRepo(db).responsesItems;
  const metadata = await repo.lookupMany('key_a', ids);
  assertEquals(files.getCalls, 0);
  const lookup = repo.lookupPayloads('key_a', ids);
  await files.waitForFirstGet();
  const startedBeforeRelease = files.getCalls;
  files.releaseAll();
  const payloads = await lookup;

  assertEquals(startedBeforeRelease, 1);
  assertEquals(metadata.map(row => row.id), ids);
  assertEquals(payloads.map(row => row.id), ids);
});

test('SQL responses items repo serializes one payload at a time within write batches', async () => {
  initFileProvider(new MemoryFileProvider());
  const db = new FakeResponsesItemsSqlDatabase();
  const repo = new SqlRepo(db).responsesItems;
  const inserts = Array.from({ length: 3 }, (_, index) => storedItem({
    id: `msg_insert_${index}`,
    apiKeyId: 'key_a',
    createdAt: 1_000 + index,
  }));

  const insert = await runWithCompressionBlocked(async () => await repo.insertMany(inserts));

  assertEquals(insert.started, 1);
  assertEquals((await repo.lookupMany('key_a', inserts.map(item => item.id))).map(row => row.id), inserts.map(item => item.id));

  const metadata = Array.from({ length: 3 }, (_, index) => storedItem({
    id: `msg_fill_${index}`,
    apiKeyId: 'key_a',
    payload: null,
    createdAt: 2_000 + index,
  }));
  await repo.insertMany(metadata);
  const fills = metadata.map((item, index) => ({
    ...item,
    payload: { item: { type: 'message', id: item.id, role: 'assistant', content: `filled ${index}` } },
  }));

  const fill = await runWithCompressionBlocked(async () => await repo.fillPayloads(fills));

  assertEquals(fill.started, 1);
  assertEquals(fill.result, 3);
});

test('SQL responses items repo spills large payloads through the runtime file provider without storing backend identity', async () => {
  const db = new FakeResponsesItemsSqlDatabase();
  const files = new MemoryFileProvider();
  initFileProvider(files);
  const repo = new SqlRepo(db).responsesItems;
  const payload = { item: { type: 'message', id: 'msg_large', content: incompressibleString(96 * 1024) } };
  const item = storedItem({
    id: 'msg_z1mVjw_0xVvS8c_KjD1sBkZk5qbdA',
    apiKeyId: 'key_a',
    payload,
    createdAt: Date.UTC(2026, 4, 28, 12),
  });

  await repo.insertMany([item]);

  const descriptor = JSON.parse(db.rows[0].payload_json!) as Record<string, unknown>;
  assertEquals(descriptor.storage, 'file');
  assertEquals('provider' in descriptor, false);
  assertEquals(typeof descriptor.key, 'string');
  assertEquals((descriptor.key as string).startsWith('responses-items/v1/expires/2026/06/27/12/'), true);
  assert((await files.get(descriptor.key as string)) !== null);
  assertEquals(await repo.lookupMany('key_a', [item.id]), [storedResponsesItemMetadata(item)]);
  assertEquals((await repo.lookupPayloads('key_a', [item.id]))[0].payload, payload);
});

test('SQL responses items deleteAll removes spilled payload files alongside the rows', async () => {
  const db = new FakeResponsesItemsSqlDatabase();
  const files = new MemoryFileProvider();
  initFileProvider(files);
  const repo = new SqlRepo(db).responsesItems;
  const item = storedItem({
    id: 'msg_z1mVjw_0xVvS8c_KjD1sBkZk5qbdA',
    apiKeyId: 'key_a',
    payload: { item: { type: 'message', id: 'msg_large', content: incompressibleString(96 * 1024) } },
    createdAt: Date.UTC(2026, 4, 28, 12),
  });

  await repo.insertMany([item]);
  const descriptor = JSON.parse(db.rows[0].payload_json!) as { key: string };
  assert((await files.get(descriptor.key)) !== null);

  await repo.deleteAll();

  assertEquals(db.rows.length, 0);
  assertEquals(await files.get(descriptor.key), null);
});

test('migration 0023 creates the responses_items table and cleanup indexes', async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  try {
    applySqlJsFile(db, '0023_responses_items.sql');

    const table = sqlJsRows<{ sql: string }>(db, "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'responses_items'")[0];
    assert(table);
    assertEquals(
      table.sql,
      `CREATE TABLE responses_items (
  id TEXT NOT NULL,
  api_key_id TEXT,
  upstream_id TEXT,
  upstream_item_id TEXT,
  item_type TEXT NOT NULL,
  payload_json TEXT,
  encrypted_content_hash TEXT,
  created_at INTEGER NOT NULL,
  CHECK (length(id) > 0),
  CHECK (length(item_type) > 0),
  CHECK (upstream_id IS NOT NULL OR upstream_item_id IS NULL)
)`,
    );

    assertEquals(
      sqlJsRows<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'responses_items' ORDER BY name").map(row => row.name),
      ['idx_responses_items_api_key_id', 'idx_responses_items_created_at', 'idx_responses_items_enc_hash', 'idx_responses_items_id_scope'],
    );
  } finally {
    db.close();
  }
});

test('migration 0025 adds responses item metadata and refresh index', async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  try {
    applySqlJsFile(db, '0023_responses_items.sql');
    db.run(`
      INSERT INTO responses_items (id, upstream_id, upstream_item_id, item_type, created_at)
      VALUES
        ('msg_z1mVjw_0xVvS8c_KjD1sBkZk5qbdA', NULL, NULL, 'message', 1),
        ('rs_mFBDiA_Lh1uXb7nD_bQb4I1CUYH2w', 'up_a', 'raw_rs_a', 'reasoning', 2)
    `);
    applySqlJsFile(db, '0025_responses_item_metadata.sql');

    assertEquals(
      sqlJsRows<{ name: string }>(db, 'PRAGMA table_info(responses_items)').map(row => row.name).filter(name => name === 'origin' || name === 'refreshed_at'),
      ['origin', 'refreshed_at'],
    );
    assertEquals(
      sqlJsRows<{ id: string; origin: string; refreshed_at: number }>(db, 'SELECT id, origin, refreshed_at FROM responses_items ORDER BY created_at'),
      [
        { id: 'msg_z1mVjw_0xVvS8c_KjD1sBkZk5qbdA', origin: 'synthetic', refreshed_at: 1 },
        { id: 'rs_mFBDiA_Lh1uXb7nD_bQb4I1CUYH2w', origin: 'upstream', refreshed_at: 2 },
      ],
    );
    assertEquals(
      sqlJsRows<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'responses_items' ORDER BY name").map(row => row.name),
      ['idx_responses_items_api_key_id', 'idx_responses_items_created_at', 'idx_responses_items_enc_hash', 'idx_responses_items_id_scope', 'idx_responses_items_refreshed_at'],
    );
    db.run("INSERT INTO responses_items (id, item_type, created_at) VALUES ('ws_WGRXTA_sVlhxg6BAV0BUzj0KkWSqA', 'web_search_call', 3)");
    assertEquals(
      sqlJsRows<{ origin: string; refreshed_at: number }>(db, "SELECT origin, refreshed_at FROM responses_items WHERE id = 'ws_WGRXTA_sVlhxg6BAV0BUzj0KkWSqA'")[0],
      { origin: 'upstream', refreshed_at: 3 },
    );
    assert(
      sqlJsRows<{ detail: string }>(db, 'EXPLAIN QUERY PLAN DELETE FROM responses_items WHERE refreshed_at < 10')
        .some(row => row.detail.includes('idx_responses_items_refreshed_at')),
    );
    assert(
      sqlJsRows<{ detail: string }>(db, 'EXPLAIN QUERY PLAN UPDATE responses_items SET payload_json = NULL WHERE payload_json IS NOT NULL AND created_at < 10')
        .some(row => row.detail.includes('idx_responses_items_created_at')),
    );
    assert(
      sqlJsRows<{ detail: string }>(
        db,
        "EXPLAIN QUERY PLAN SELECT id FROM responses_items WHERE COALESCE(api_key_id, '') = COALESCE('key_a', '') AND id IN ('msg_z1mVjw_0xVvS8c_KjD1sBkZk5qbdA')",
      ).some(row => row.detail.includes('idx_responses_items_id_scope')),
    );
    assert(
      sqlJsRows<{ detail: string }>(
        db,
        "EXPLAIN QUERY PLAN UPDATE responses_items SET refreshed_at = 10 WHERE COALESCE(api_key_id, '') = COALESCE('key_a', '') AND id IN ('msg_z1mVjw_0xVvS8c_KjD1sBkZk5qbdA') AND refreshed_at < 10",
      ).some(row => row.detail.includes('idx_responses_items_id_scope')),
    );
  } finally {
    db.close();
  }
});

test('migration 0026 adds Responses state snapshots and content hash index', async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  try {
    applySqlJsFile(db, '0023_responses_items.sql');
    applySqlJsFile(db, '0025_responses_item_metadata.sql');
    applySqlJsFile(db, '0026_responses_state.sql');

    assertEquals(
      sqlJsRows<{ name: string }>(db, 'PRAGMA table_info(responses_items)').map(row => row.name).filter(name => name === 'content_hash'),
      ['content_hash'],
    );
    assertEquals(
      sqlJsRows<{ sql: string }>(db, "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'responses_snapshots'")[0].sql,
      `CREATE TABLE responses_snapshots (
  id TEXT NOT NULL,
  api_key_id TEXT,
  item_ids_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  refreshed_at INTEGER NOT NULL,
  CHECK (length(id) > 0),
  CHECK (length(item_ids_json) > 0)
)`,
    );
    assert(
      sqlJsRows<{ detail: string }>(
        db,
        "EXPLAIN QUERY PLAN SELECT id FROM responses_items WHERE api_key_id IS 'key_a' AND content_hash IN ('hash_a') ORDER BY refreshed_at DESC, created_at DESC, id ASC",
      ).some(row => row.detail.includes('idx_responses_items_content_hash')),
    );
    assert(
      sqlJsRows<{ detail: string }>(
        db,
        "EXPLAIN QUERY PLAN SELECT id FROM responses_snapshots WHERE id = 'resp_a' AND COALESCE(api_key_id, '') = COALESCE('key_a', '')",
      ).some(row => row.detail.includes('idx_responses_snapshots_id_scope')),
    );
    assert(
      sqlJsRows<{ detail: string }>(db, 'EXPLAIN QUERY PLAN DELETE FROM responses_snapshots WHERE refreshed_at < 10')
        .some(row => row.detail.includes('idx_responses_snapshots_refreshed_at')),
    );
  } finally {
    db.close();
  }
});

type FakeResponsesItemRow = {
  id: string;
  api_key_id: string | null;
  upstream_id: string | null;
  upstream_item_id: string | null;
  item_type: string;
  origin: StoredResponsesItem['origin'];
  payload_json: string | null;
  content_hash: string | null;
  encrypted_content_hash: string | null;
  created_at: number;
  refreshed_at: number;
};

class FakeResponsesItemsSqlPreparedStatement {
  private binds: unknown[] = [];

  constructor(private db: FakeResponsesItemsSqlDatabase, private query: string) {}

  bind(...values: unknown[]): FakeResponsesItemsSqlPreparedStatement {
    this.binds = values;
    return this;
  }

  first(): Promise<null> {
    throw new Error(`Unsupported first() query in responses items test: ${this.query}`);
  }

  all<T>(): Promise<{ results: T[]; success: true; meta: Record<string, unknown> }> {
    if (this.query.includes('FROM responses_items')) {
      return Promise.resolve({
        results: this.db.lookup(this.query, this.binds) as T[],
        success: true,
        meta: {},
      });
    }

    throw new Error(`Unsupported all() query in responses items test: ${this.query}`);
  }

  run(): Promise<{ results: never[]; success: true; meta: Record<string, unknown> }> {
    if (this.query.startsWith('INSERT INTO responses_items')) {
      this.db.insert(this.binds);
      return Promise.resolve({ results: [], success: true, meta: { changes: 1 } });
    }
    if (this.query.startsWith('UPDATE responses_items SET refreshed_at = ?')) {
      const changes = this.db.refresh(this.binds);
      return Promise.resolve({ results: [], success: true, meta: { changes } });
    }
    if (this.query.includes('SET payload_json = ?, content_hash = ?, encrypted_content_hash = ?, created_at = ?, refreshed_at = ?')) {
      const changes = this.db.fillPayload(this.binds);
      return Promise.resolve({ results: [], success: true, meta: { changes } });
    }
    if (this.query.startsWith('UPDATE responses_items SET payload_json = NULL')) {
      const changes = this.db.clearPayloadOlderThan(this.binds[0] as number);
      return Promise.resolve({ results: [], success: true, meta: { changes } });
    }
    if (this.query.startsWith('DELETE FROM responses_items WHERE refreshed_at < ?')) {
      const changes = this.db.deleteOlderThan(this.binds[0] as number);
      return Promise.resolve({ results: [], success: true, meta: { changes } });
    }
    if (this.query === 'DELETE FROM responses_items') {
      const changes = this.db.rows.length;
      this.db.rows = [];
      return Promise.resolve({ results: [], success: true, meta: { changes } });
    }

    throw new Error(`Unsupported run() query in responses items test: ${this.query}`);
  }
}

class FakeResponsesItemsSqlDatabase implements SqlDatabase {
  exec(): Promise<unknown> { return Promise.resolve(undefined); }

  rows: FakeResponsesItemRow[] = [];

  prepare(query: string): FakeResponsesItemsSqlPreparedStatement {
    return new FakeResponsesItemsSqlPreparedStatement(this, query);
  }

  async batch(statements: FakeResponsesItemsSqlPreparedStatement[]): Promise<Array<{ results: never[]; success: true; meta: Record<string, unknown> }>> {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }

  insert(binds: unknown[]): void {
    const [id, apiKeyId, upstreamId, upstreamItemId, itemType, origin, payload, contentHash, encryptedContentHash, createdAt, refreshedAt] = binds as [
      string,
      string | null,
      string | null,
      string | null,
      string,
      StoredResponsesItem['origin'],
      string | null,
      string | null,
      string | null,
      number,
      number,
    ];
    const existing = this.rows.find(row => row.id === id && row.api_key_id === apiKeyId);
    if (existing) return;  // mirrors sql.ts `ON CONFLICT DO NOTHING`
    this.rows.push({
      id,
      api_key_id: apiKeyId,
      upstream_id: upstreamId,
      upstream_item_id: upstreamItemId,
      item_type: itemType,
      origin,
      payload_json: payload,
      content_hash: contentHash,
      encrypted_content_hash: encryptedContentHash,
      created_at: createdAt,
      refreshed_at: refreshedAt,
    });
  }

  refresh(binds: unknown[]): number {
    const [refreshedAt, apiKeyId, ...rest] = binds as [number, string | null, ...Array<string | number>];
    const ids = new Set(rest.slice(0, -1) as string[]);
    const maxExisting = rest.at(-1) as number;
    let changes = 0;
    for (const row of this.rows) {
      if (row.api_key_id === apiKeyId && ids.has(row.id) && row.refreshed_at < maxExisting) {
        row.refreshed_at = refreshedAt;
        changes += 1;
      }
    }
    return changes;
  }

  fillPayload(binds: unknown[]): number {
    const [payload, contentHash, encryptedContentHash, createdAt, refreshedAt, apiKeyId, id] = binds as [
      string,
      string | null,
      string | null,
      number,
      number,
      string | null,
      string,
    ];
    const row = this.rows.find(candidate => candidate.id === id && candidate.api_key_id === apiKeyId);
    if (row?.payload_json !== null) return 0;
    row.payload_json = payload;
    row.content_hash = contentHash;
    row.encrypted_content_hash = encryptedContentHash;
    row.created_at = createdAt;
    row.refreshed_at = refreshedAt;
    return 1;
  }

  lookup(query: string, binds: unknown[]): unknown[] {
    const [apiKeyId, ...keys] = binds as [string | null, ...string[]];
    const wanted = new Set(keys);
    let matches: FakeResponsesItemRow[];
    if (query.includes('encrypted_content_hash IN')) {
      matches = this.rows
        .filter(row => row.api_key_id === apiKeyId && row.encrypted_content_hash !== null && wanted.has(row.encrypted_content_hash))
        .map(row => ({ ...row }))
        .toSorted(compareFakeResponsesItemsByFreshness);
    } else if (query.includes('content_hash IN')) {
      matches = this.rows
        .filter(row => row.api_key_id === apiKeyId && row.content_hash !== null && wanted.has(row.content_hash))
        .map(row => ({ ...row }))
        .toSorted(compareFakeResponsesItemsByFreshness);
    } else {
      matches = this.rows.filter(row => wanted.has(row.id) && row.api_key_id === apiKeyId);
      const order = new Map(keys.map((id, index) => [id, index]));
      matches = matches.map(row => ({ ...row })).toSorted((a, b) => order.get(a.id)! - order.get(b.id)!);
    }
    if (query.startsWith('SELECT id, payload_json')) {
      return matches.map(row => ({ id: row.id, payload_json: row.payload_json }));
    }
    return matches.map(({ payload_json: payloadJson, ...row }) => ({ ...row, has_payload: payloadJson === null ? 0 : 1 }));
  }

  clearPayloadOlderThan(createdBefore: number): number {
    let changes = 0;
    for (const row of this.rows) {
      if (row.created_at < createdBefore && row.payload_json !== null) {
        row.payload_json = null;
        changes += 1;
      }
    }
    return changes;
  }

  deleteOlderThan(createdBefore: number): number {
    const previousLength = this.rows.length;
    this.rows = this.rows.filter(row => row.refreshed_at >= createdBefore);
    return previousLength - this.rows.length;
  }
}

const compareFakeResponsesItemsByFreshness = (a: FakeResponsesItemRow, b: FakeResponsesItemRow): number =>
  b.refreshed_at - a.refreshed_at || b.created_at - a.created_at || a.id.localeCompare(b.id);

type SqlJsDatabase = {
  run(sql: string): void;
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>;
  close(): void;
};

const migrationSqlByPath = import.meta.glob('../../migrations/*.sql', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const migrationSqlByFilename = new Map(Object.entries(migrationSqlByPath).map(([path, sql]) => [path.slice(path.lastIndexOf('/') + 1), sql]));

const applySqlJsFile = (db: SqlJsDatabase, filename: string): void => {
  const sql = migrationSqlByFilename.get(filename);
  if (!sql) throw new Error(`Missing migration SQL fixture: ${filename}`);
  db.run(sql);
};

const sqlJsRows = <T>(db: SqlJsDatabase, sql: string): T[] => {
  const [result] = db.exec(sql);
  if (!result) return [];
  return result.values.map(values => Object.fromEntries(result.columns.map((column, index) => [column, values[index] ?? null])) as T);
};
