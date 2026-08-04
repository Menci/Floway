import { afterEach, expect, test, vi } from 'vitest';

import { initDumpStore } from '../../src/dump/registry.ts';
import type { DumpWriteRecord } from '../../src/dump/types.ts';
import { FileDumpStore } from '../../src/repo/dump-store.ts';
import { initRepo } from '../../src/repo/index.ts';
import { quantizeResponsesRefreshedAt, RESPONSES_REFRESH_GRANULARITY_MS } from '../../src/repo/responses-retention.ts';
import { SqlRepo } from '../../src/repo/sql.ts';
import type { ApiKey, StoredResponsesItem } from '../../src/repo/types.ts';
import { sweepExpirations } from '../../src/scheduled/expiration-sweeps.ts';
import { InMemoryRepo } from '../repo/memory.ts';
import { createSqliteTestDb, createSqlJsDatabase, migrationSqlByFilename, wrapSqlJsDatabase } from '../repo/test-sqlite.ts';
import { initFileStore, MemoryFileStore } from '@floway-dev/platform';

afterEach(() => vi.useRealTimers());

const RESPONSES_RETENTION_SECONDS = 24 * 60 * 60;

const key = (now: number): ApiKey => ({
  id: 'key-a',
  userId: 1,
  name: 'Sweep key',
  key: 'raw-sweep-key',
  serverSecret: '55'.repeat(32),
  createdAt: new Date(now).toISOString(),
  upstreamIds: null,
  deletedAt: null,
  dumpRetentionSeconds: 3600,
  responsesRetentionSeconds: RESPONSES_RETENTION_SECONDS,
});

const responseItem = (id: string, refreshedAt: number, apiKeyId = 'key-a'): StoredResponsesItem => ({
  id,
  apiKeyId,
  payload: { item: { type: 'message', id, role: 'assistant', content: [] } },
  itemHash: `hash-${id}`,
  refreshedAt,
});

const dumpRecord = (id: string, completedAt: number): DumpWriteRecord => ({
  meta: {
    id,
    startedAt: completedAt - 1,
    completedAt,
    method: 'POST',
    path: '/v1/responses',
    status: 200,
    upstream: null,
    model: 'gpt-test',
    inputTokens: null,
    outputTokens: null,
    requestBytes: 0,
    responseBytes: 0,
    durationMs: 1,
    error: null,
  },
  request: {
    method: 'POST',
    path: '/v1/responses',
    headers: [],
    body: { encoding: 'identity', bytes: new Uint8Array(), decodedByteLength: 0 },
  },
  response: { status: 200, headers: [], body: { type: 'none' } },
});

test('one fair driver drains bounded Responses and dump backlogs', async () => {
  const now = Date.UTC(2026, 6, 23, 12);
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const db = await createSqliteTestDb();
  const repo = new SqlRepo(db);
  initRepo(repo);
  const files = new MemoryFileStore();
  initFileStore(files);
  const dumps = new FileDumpStore(db, files);
  initDumpStore(dumps);
  await repo.apiKeys.save({ ...key(now), dumpRetentionSeconds: 7200, responsesRetentionSeconds: 2 * RESPONSES_RETENTION_SECONDS });

  const responsesExpiredAt = now - 2 * RESPONSES_REFRESH_GRANULARITY_MS - 1;
  const dumpExpiredAt = now - 3600_000 - 1;
  await repo.responsesItems.insertMany(
    Array.from({ length: 150 }, (_, index) => responseItem(`msg-expired-${index}`, responsesExpiredAt)),
    0,
  );
  await repo.responsesItems.insertMany([responseItem('msg-current', now)], 0);
  for (let index = 0; index < 150; index += 1) {
    await dumps.put('key-a', dumpRecord(`01K00000000000000000${String(index).padStart(4, '0')}`, dumpExpiredAt));
  }
  await dumps.put('key-a', dumpRecord('01K00000000000000000LIVE', now));
  await repo.apiKeys.update('key-a', { dumpRetentionSeconds: 3600, responsesRetentionSeconds: RESPONSES_RETENTION_SECONDS });

  await sweepExpirations(now);

  expect((await db.prepare("SELECT COUNT(*) AS count FROM responses_items WHERE id LIKE 'msg-expired-%'").first<{ count: number }>())?.count).toBe(50);
  expect((await db.prepare('SELECT COUNT(*) AS count FROM dump_records WHERE created_at < ?').bind(now).first<{ count: number }>())?.count).toBe(50);
  await sweepExpirations(now + 1);

  expect((await db.prepare("SELECT COUNT(*) AS count FROM responses_items WHERE id LIKE 'msg-expired-%'").first<{ count: number }>())?.count).toBe(0);
  expect((await db.prepare('SELECT COUNT(*) AS count FROM dump_records WHERE created_at < ?').bind(now).first<{ count: number }>())?.count).toBe(0);
  expect(await repo.responsesItems.lookupMany('key-a', ['msg-current'], 0)).toHaveLength(1);
  expect((await dumps.list('key-a', { limit: 10 })).map(row => row.id)).toEqual(['01K00000000000000000LIVE']);
});

test('a partial hot key yields the current tick to another due key', async () => {
  const now = Date.UTC(2026, 6, 23, 12);
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const db = await createSqliteTestDb();
  const repo = new SqlRepo(db);
  initRepo(repo);
  initFileStore(new MemoryFileStore());
  await repo.apiKeys.save({ ...key(now), id: 'a-hot', key: 'raw-a-hot', serverSecret: '77'.repeat(32), responsesRetentionSeconds: 2 * RESPONSES_RETENTION_SECONDS });
  await repo.apiKeys.save({ ...key(now), id: 'b-small', key: 'raw-b-small', serverSecret: '88'.repeat(32), responsesRetentionSeconds: 2 * RESPONSES_RETENTION_SECONDS });
  const expiredAt = now - 2 * RESPONSES_REFRESH_GRANULARITY_MS - 1;
  await repo.responsesItems.insertMany(
    Array.from({ length: 450 }, (_, index) => responseItem(`msg-hot-${index}`, expiredAt, 'a-hot')),
    0,
  );
  await repo.responsesItems.insertMany([responseItem('msg-small', expiredAt, 'b-small')], 0);
  await repo.apiKeys.update('a-hot', { responsesRetentionSeconds: RESPONSES_RETENTION_SECONDS });
  await repo.apiKeys.update('b-small', { responsesRetentionSeconds: RESPONSES_RETENTION_SECONDS });

  await sweepExpirations(now);

  expect((await db.prepare("SELECT COUNT(*) AS count FROM responses_items WHERE api_key_id = 'a-hot'").first<{ count: number }>())?.count).toBe(350);
  expect((await db.prepare("SELECT COUNT(*) AS count FROM responses_items WHERE api_key_id = 'b-small'").first<{ count: number }>())?.count).toBe(0);
});

test('a concurrent schedule wins over stale completion', async () => {
  const db = await createSqliteTestDb();
  const repo = new SqlRepo(db);
  await repo.expirationSweeps.schedule('responses', 'key-race', 0);
  const claim = await repo.expirationSweeps.claim('claim-race', 10, 0);
  if (claim === null) throw new Error('expected expiration claim');

  await repo.expirationSweeps.schedule('responses', 'key-race', 0);
  await repo.expirationSweeps.complete('claim-race', claim.revision, { kind: 'drained', nextDueAt: 10_000 });

  const row = await db.prepare(
    "SELECT due_at, claim_token FROM expiration_sweeps WHERE domain = 'responses' AND key_id = 'key-race'",
  ).first<{ due_at: number; claim_token: string | null }>();
  expect(row).toEqual({ due_at: 0, claim_token: null });
});

test('a later Responses row inserted during a claim prevents queue deletion', async () => {
  const now = Date.UTC(2026, 6, 23, 12);
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const db = await createSqliteTestDb();
  const repo = new SqlRepo(db);
  initFileStore(new MemoryFileStore());
  await repo.apiKeys.save(key(now));
  await repo.expirationSweeps.schedule('responses', 'key-a', 0);
  const claim = await repo.expirationSweeps.claim('claim-row-race', now, 0);
  if (claim === null) throw new Error('expected expiration claim');

  await repo.responsesItems.insertMany([responseItem('msg-later', now)], 0);
  await repo.expirationSweeps.complete('claim-row-race', claim.revision, { kind: 'drained', nextDueAt: null });

  const row = await db.prepare(
    "SELECT due_at, claim_token FROM expiration_sweeps WHERE domain = 'responses' AND key_id = 'key-a'",
  ).first<{ due_at: number; claim_token: string | null }>();
  expect(row).toEqual({ due_at: 0, claim_token: null });
});

test('partial completion yields even when a concurrent Responses row bumps the revision', async () => {
  const now = Date.UTC(2026, 6, 23, 12);
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const db = await createSqliteTestDb();
  const repo = new SqlRepo(db);
  initFileStore(new MemoryFileStore());
  await repo.apiKeys.save(key(now));
  await repo.expirationSweeps.schedule('responses', 'key-a', 0);
  const claim = await repo.expirationSweeps.claim('claim-partial-race', now, 0);
  if (claim === null) throw new Error('expected expiration claim');
  await repo.responsesItems.insertMany([responseItem('msg-concurrent', now)], 0);

  await repo.expirationSweeps.complete('claim-partial-race', claim.revision, { kind: 'partial', retryAt: now + 1 });

  expect(await db.prepare(
    "SELECT due_at, claim_token FROM expiration_sweeps WHERE domain = 'responses' AND key_id = 'key-a'",
  ).first<{ due_at: number; claim_token: string | null }>()).toEqual({ due_at: now + 1, claim_token: null });
});

test('migration 0066 bounds existing-row discovery and tracks older dump files on deletion', async () => {
  const db = await createSqlJsDatabase();
  try {
    for (const [filename, sql] of migrationSqlByFilename) {
      if (filename === '0066_expiration_sweeps.sql') break;
      db.run(sql);
    }
    db.run(
      `INSERT INTO api_keys
       (id, user_id, name, key, created_at, upstream_ids, deleted_at, dump_retention_seconds, server_secret, responses_retention_seconds)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['key-old-dump', 1, 'Old dump', 'raw-old-dump', '2026-01-01T00:00:00Z', null, null, 3600, '66'.repeat(32), 0],
    );
    db.run(
      `INSERT INTO dump_records
       (key_id, id, created_at, upstream_id, meta_json, request_headers_json, response_headers_json, request_body_descriptor, response_body_descriptor)
       VALUES (?, ?, ?, NULL, ?, '[]', '[]', ?, NULL)`,
      [
        'key-old-dump',
        '01K00000000000000000OLD0',
        1_000,
        '{}',
        JSON.stringify({ key: 'dumps/v1/key-old-dump/old.req.gz', type: 'bytes' }),
      ],
    );

    const migration = migrationSqlByFilename.find(([filename]) => filename === '0066_expiration_sweeps.sql');
    if (migration === undefined) throw new Error('missing migration 0066_expiration_sweeps.sql');
    db.run(migration[1]);

    expect(db.exec('SELECT domain, key_id FROM expiration_sweeps')[0]?.values ?? []).toEqual([]);
    expect(db.exec('SELECT source, next_rowid, complete FROM cleanup_backfills ORDER BY source')[0].values)
      .toEqual([
        ['dump_records', 0, 0],
        ['responses_items', 0, 0],
        ['responses_snapshots', 0, 0],
      ]);

    for (const [id, requestDescriptor, responseDescriptor] of [
      ['01K00000000000000000BAD0', JSON.stringify({ type: 'bytes' }), null],
      ['01K00000000000000000BAD1', null, JSON.stringify({ key: null, type: 'bytes' })],
    ] as const) {
      expect(() => db.run(
        `INSERT INTO dump_records
         (key_id, id, created_at, upstream_id, meta_json, request_headers_json, response_headers_json, request_body_descriptor, response_body_descriptor)
         VALUES (?, ?, ?, NULL, '{}', '[]', '[]', ?, ?)`,
        ['key-old-dump', id, Date.UTC(2026, 0, 2, 3), requestDescriptor, responseDescriptor],
      )).toThrow(/file key must be text/u);
    }

    const bridgeCreatedAt = Date.UTC(2026, 0, 2, 3);
    const bridgeId = '01K00000000000000000OLD1';
    const bridgeKey = `dumps/v1/key-old-dump/2026010203/${bridgeId}.req.gz`;
    db.run(
      `INSERT INTO dump_records
       (key_id, id, created_at, upstream_id, meta_json, request_headers_json, response_headers_json, request_body_descriptor, response_body_descriptor)
       VALUES (?, ?, ?, NULL, ?, '[]', '[]', ?, NULL)`,
      ['key-old-dump', bridgeId, bridgeCreatedAt, '{}', JSON.stringify({ key: bridgeKey, type: 'bytes' })],
    );
    expect(db.exec(`SELECT file_key, state FROM spilled_files WHERE owner_key = json_array('key-old-dump', '${bridgeId}')`)[0].values)
      .toEqual([[bridgeKey, 'owned']]);

    db.run("DELETE FROM dump_records WHERE key_id = 'key-old-dump'");
    expect(db.exec("SELECT file_key, owner_kind, state FROM spilled_files WHERE owner_key = json_array('key-old-dump', '01K00000000000000000OLD0')")[0].values)
      .toEqual([['dumps/v1/key-old-dump/old.req.gz', 'dump-request', 'retired']]);
  } finally {
    db.close();
  }
});

test('expiration backfill rejects malformed legacy dump descriptors with row context', async () => {
  const db = await createSqlJsDatabase();
  try {
    for (const [filename, sql] of migrationSqlByFilename) {
      if (filename === '0066_expiration_sweeps.sql') break;
      db.run(sql);
    }
    db.run(
      `INSERT INTO api_keys
       (id, user_id, name, key, created_at, upstream_ids, deleted_at, dump_retention_seconds, server_secret, responses_retention_seconds)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['key-legacy', 1, 'Legacy', 'raw-legacy', '2026-01-01T00:00:00Z', null, null, 3600, '66'.repeat(32), 0],
    );
    const recordId = '01K00000000000000000BAD0';
    db.run(
      `INSERT INTO dump_records
       (key_id, id, created_at, upstream_id, meta_json, request_headers_json, response_headers_json, request_body_descriptor, response_body_descriptor)
       VALUES (?, ?, ?, NULL, '{}', '[]', NULL, ?, NULL)`,
      ['key-legacy', recordId, 1_000, JSON.stringify({ key: 'dumps/v1/key-legacy/old.req.gz', type: 'chunks' })],
    );
    const migration = migrationSqlByFilename.find(([filename]) => filename === '0066_expiration_sweeps.sql');
    if (migration === undefined) throw new Error('missing migration 0066_expiration_sweeps.sql');
    db.run(migration[1]);

    const repo = new SqlRepo(wrapSqlJsDatabase(db));
    await expect(repo.expirationSweeps.backfillCleanupTracking(500)).rejects.toThrow(
      new RegExp(`Invalid dump record key-legacy/${recordId} request body descriptor during expiration backfill.*type`, 'su'),
    );
  } finally {
    db.close();
  }
});

test('expiration claims and expired-row deletions use their bounded range indexes', async () => {
  const db = await createSqliteTestDb();
  const explain = async (sql: string, ...values: Array<string | number>): Promise<string> => {
    const { results } = await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...values).all<{ detail: string }>();
    return results.map(row => row.detail).join('\n');
  };

  const claimPlan = await explain(
    `UPDATE expiration_sweeps SET claim_token = ?, claimed_at = ?
     WHERE (domain, key_id) = (
       SELECT domain, key_id FROM expiration_sweeps
       WHERE due_at <= ? AND (claim_token IS NULL OR claimed_at < ?)
       ORDER BY due_at, key_id, domain LIMIT 1
     )`,
    'claim', 1, 1, 0,
  );
  expect(claimPlan).toContain('idx_expiration_sweeps_due');

  const expirationClaimLookup = await explain(
    'SELECT domain, key_id, revision FROM expiration_sweeps WHERE claim_token = ?',
    'claim',
  );
  expect(expirationClaimLookup).toContain('idx_expiration_sweeps_claim');

  const spilledClaimLookup = await explain(
    'SELECT file_key FROM spilled_files WHERE claim_token = ? ORDER BY file_key',
    'claim',
  );
  expect(spilledClaimLookup).toContain('idx_spilled_files_claim');

  const responsesPlan = await explain(
    `DELETE FROM responses_items WHERE rowid IN (
       SELECT stored.rowid FROM api_keys CROSS JOIN responses_items AS stored
       WHERE api_keys.id = ? AND api_keys.deleted_at IS NULL
         AND api_keys.responses_retention_seconds > 0
         AND stored.api_key_id = api_keys.id
         AND stored.refreshed_at < ? - api_keys.responses_retention_seconds * 1000
       ORDER BY stored.refreshed_at, stored.rowid LIMIT ?
     )`,
    'key-a', 1, 100,
  );
  expect(responsesPlan).toContain('idx_responses_items_key_refresh');

  const dumpsPlan = await explain(
    `DELETE FROM dump_records WHERE rowid IN (
       SELECT records.rowid FROM api_keys CROSS JOIN dump_records AS records
       WHERE api_keys.id = ? AND api_keys.deleted_at IS NULL
         AND api_keys.dump_retention_seconds IS NOT NULL
         AND records.key_id = api_keys.id
         AND records.created_at < ? - api_keys.dump_retention_seconds * 1000
       ORDER BY records.created_at, records.rowid LIMIT ?
     )`,
    'key-a', 1, 100,
  );
  expect(dumpsPlan).toContain('idx_dump_records_key_created');
});

test('bounded cleanup backfill tracks rows whose API key was hard-deleted', async () => {
  const now = Date.UTC(2026, 6, 23, 12);
  const db = await createSqliteTestDb();
  const repo = new SqlRepo(db);
  await repo.apiKeys.save(key(now));
  const recordId = '01K00000000000000000ORPH';
  const fileKey = `dumps/v1/key-a/1970010100/${recordId}.req.gz`;
  await db.prepare(
    `INSERT INTO dump_records
     (key_id, id, created_at, upstream_id, meta_json, request_headers_json, response_headers_json, request_body_descriptor, response_body_descriptor)
     VALUES ('key-a', ?, 1, NULL, '{}', '[]', NULL, ?, NULL)`,
  ).bind(recordId, JSON.stringify({ key: fileKey, type: 'bytes' })).run();
  await db.prepare("DELETE FROM api_keys WHERE id = 'key-a'").run();
  await db.prepare("DELETE FROM expiration_sweeps WHERE key_id = 'key-a'").run();
  await db.prepare('DELETE FROM spilled_files WHERE file_key = ?').bind(fileKey).run();

  await repo.expirationSweeps.backfillCleanupTracking(500);
  expect(await db.prepare(
    "SELECT due_at FROM expiration_sweeps WHERE domain = 'dumps' AND key_id = 'key-a'",
  ).first<{ due_at: number }>()).toEqual({ due_at: 0 });
  expect(await db.prepare(
    'SELECT owner_kind, owner_key, state FROM spilled_files WHERE file_key = ?',
  ).bind(fileKey).first()).toEqual({
    owner_kind: 'dump-request',
    owner_key: JSON.stringify(['key-a', recordId]),
    state: 'owned',
  });
});

test('bounded cleanup backfill skips API keys without stored state', async () => {
  const now = Date.UTC(2026, 6, 23, 12);
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const db = await createSqliteTestDb();
  const repo = new SqlRepo(db);
  initFileStore(new MemoryFileStore());
  await repo.apiKeys.save(key(now));
  await repo.apiKeys.save({ ...key(now), id: 'key-empty', key: 'raw-empty', serverSecret: '99'.repeat(32) });
  await repo.responsesItems.insertMany([responseItem('msg-owned', now)], 0);
  await repo.responsesSnapshots.insert({ id: 'resp-owned', apiKeyId: 'key-a', itemIds: ['msg-owned'], refreshedAt: now });
  await db.prepare("UPDATE expiration_sweeps SET due_at = ? WHERE domain = 'responses' AND key_id = 'key-a'")
    .bind(now + 3600_000)
    .run();

  await repo.expirationSweeps.backfillCleanupTracking(500);

  expect((await db.prepare('SELECT domain, key_id, due_at FROM expiration_sweeps ORDER BY domain, key_id').all()).results)
    .toEqual([{ domain: 'responses', key_id: 'key-a', due_at: 0 }]);
  await repo.apiKeys.update('key-empty', { responsesRetentionSeconds: 2 * RESPONSES_RETENTION_SECONDS, dumpRetentionSeconds: 7200 });
  expect(await db.prepare("SELECT domain FROM expiration_sweeps WHERE key_id = 'key-empty'").first()).toBeNull();
});

test('in-memory Responses rows enter the same expiration driver', async () => {
  const now = Date.UTC(2026, 6, 23, 12);
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const repo = new InMemoryRepo();
  initRepo(repo);
  initFileStore(new MemoryFileStore());
  await repo.apiKeys.save(key(now));
  const item = responseItem('msg-memory', now);
  await repo.responsesItems.insertMany([item], 0);
  await repo.responsesSnapshots.insert({ id: 'resp-memory', apiKeyId: 'key-a', itemIds: [item.id], refreshedAt: now });

  const expiresAt = quantizeResponsesRefreshedAt(now)
    + RESPONSES_RETENTION_SECONDS * 1000
    + RESPONSES_REFRESH_GRANULARITY_MS;
  await sweepExpirations(expiresAt);
  expect(await repo.responsesItems.lookupMany('key-a', [item.id], 0)).toEqual([{
    ...item,
    refreshedAt: quantizeResponsesRefreshedAt(item.refreshedAt),
  }]);
  expect(await repo.responsesSnapshots.lookup('key-a', 'resp-memory', 0)).not.toBeNull();

  await sweepExpirations(expiresAt + 1);

  expect(await repo.responsesItems.lookupMany('key-a', [item.id], 0)).toEqual([]);
  expect(await repo.responsesSnapshots.lookup('key-a', 'resp-memory', 0)).toBeNull();
});
