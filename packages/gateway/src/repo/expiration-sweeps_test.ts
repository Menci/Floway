import initSqlJs from 'sql.js';
import { afterEach, expect, test, vi } from 'vitest';

import { FileDumpStore } from './dump-store.ts';
import { sweepExpirations } from './expiration-sweeps.ts';
import { initRepo } from './index.ts';
import { SqlRepo } from './sql.ts';
import { createSqliteTestDb, migrationSqlByFilename } from './test-sqlite.ts';
import type { ApiKey, StoredResponsesItem } from './types.ts';
import { initDumpStore } from '../dump/registry.ts';
import type { DumpWriteRecord } from '../dump/types.ts';
import { initFileProvider, MemoryFileProvider } from '@floway-dev/platform';

afterEach(() => vi.useRealTimers());

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
  responsesRetentionSeconds: 3600,
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
  const files = new MemoryFileProvider();
  initFileProvider(files);
  const dumps = new FileDumpStore(db, files);
  initDumpStore(dumps);
  await repo.apiKeys.save({ ...key(now), dumpRetentionSeconds: 7200, responsesRetentionSeconds: 7200 });

  const expiredAt = now - 3600_000 - 1;
  await repo.responsesItems.insertMany(
    Array.from({ length: 150 }, (_, index) => responseItem(`msg-expired-${index}`, expiredAt)),
    0,
  );
  await repo.responsesItems.insertMany([responseItem('msg-current', now)], 0);
  for (let index = 0; index < 150; index += 1) {
    await dumps.put('key-a', dumpRecord(`01K00000000000000000${String(index).padStart(4, '0')}`, expiredAt));
  }
  await dumps.put('key-a', dumpRecord('01K00000000000000000LIVE', now));
  await repo.apiKeys.update('key-a', { dumpRetentionSeconds: 3600, responsesRetentionSeconds: 3600 });

  await sweepExpirations(now);

  expect((await db.prepare('SELECT COUNT(*) AS count FROM responses_items WHERE refreshed_at < ?').bind(now).first<{ count: number }>())?.count).toBe(50);
  expect((await db.prepare('SELECT COUNT(*) AS count FROM dump_records WHERE created_at < ?').bind(now).first<{ count: number }>())?.count).toBe(50);
  await sweepExpirations(now + 1);

  expect((await db.prepare('SELECT COUNT(*) AS count FROM responses_items WHERE refreshed_at < ?').bind(now).first<{ count: number }>())?.count).toBe(0);
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
  initFileProvider(new MemoryFileProvider());
  await repo.apiKeys.save({ ...key(now), id: 'a-hot', key: 'raw-a-hot', serverSecret: '77'.repeat(32), responsesRetentionSeconds: 7200 });
  await repo.apiKeys.save({ ...key(now), id: 'b-small', key: 'raw-b-small', serverSecret: '88'.repeat(32), responsesRetentionSeconds: 7200 });
  const expiredAt = now - 3600_000 - 1;
  await repo.responsesItems.insertMany(
    Array.from({ length: 450 }, (_, index) => responseItem(`msg-hot-${index}`, expiredAt, 'a-hot')),
    0,
  );
  await repo.responsesItems.insertMany([responseItem('msg-small', expiredAt, 'b-small')], 0);
  await repo.apiKeys.update('a-hot', { responsesRetentionSeconds: 3600 });
  await repo.apiKeys.update('b-small', { responsesRetentionSeconds: 3600 });

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

test('a later owner inserted during a claim prevents queue deletion', async () => {
  const now = Date.UTC(2026, 6, 23, 12);
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const db = await createSqliteTestDb();
  const repo = new SqlRepo(db);
  initFileProvider(new MemoryFileProvider());
  await repo.apiKeys.save(key(now));
  await repo.expirationSweeps.schedule('responses', 'key-a', 0);
  const claim = await repo.expirationSweeps.claim('claim-owner-race', now, 0);
  if (claim === null) throw new Error('expected expiration claim');

  await repo.responsesItems.insertMany([responseItem('msg-later', now)], 0);
  await repo.expirationSweeps.complete('claim-owner-race', claim.revision, { kind: 'drained', nextDueAt: null });

  const row = await db.prepare(
    "SELECT due_at, claim_token FROM expiration_sweeps WHERE domain = 'responses' AND key_id = 'key-a'",
  ).first<{ due_at: number; claim_token: string | null }>();
  expect(row).toEqual({ due_at: 0, claim_token: null });
});

test('partial completion yields even when a concurrent owner bumps the revision', async () => {
  const now = Date.UTC(2026, 6, 23, 12);
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const db = await createSqliteTestDb();
  const repo = new SqlRepo(db);
  initFileProvider(new MemoryFileProvider());
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

test('migration 0066 queues existing keys and retires pre-ledger dump files on deletion', async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
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

    expect(db.exec("SELECT domain, due_at FROM expiration_sweeps WHERE key_id = 'key-old-dump' ORDER BY domain")[0].values)
      .toEqual([['dumps', 0], ['responses', 0]]);

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

test('expiration claims and owner deletions use their bounded range indexes', async () => {
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

test('bounded dump backfill schedules rows whose API key was hard-removed', async () => {
  const now = Date.UTC(2026, 6, 23, 12);
  const db = await createSqliteTestDb();
  const repo = new SqlRepo(db);
  await repo.apiKeys.save(key(now));
  await db.prepare(
    `INSERT INTO dump_records
     (key_id, id, created_at, upstream_id, meta_json, request_headers_json, response_headers_json, request_body_descriptor, response_body_descriptor)
     VALUES ('key-a', '01K00000000000000000ORPH', 1, NULL, '{}', '[]', NULL, NULL, NULL)`,
  ).run();
  await db.prepare("DELETE FROM api_keys WHERE id = 'key-a'").run();
  await db.prepare("DELETE FROM expiration_sweeps WHERE key_id = 'key-a'").run();

  expect(await repo.expirationSweeps.backfillDumpKeys(500)).toBe(true);
  expect(await db.prepare(
    "SELECT due_at FROM expiration_sweeps WHERE domain = 'dumps' AND key_id = 'key-a'",
  ).first<{ due_at: number }>()).toEqual({ due_at: 0 });
});
