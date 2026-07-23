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

const responseItem = (id: string, refreshedAt: number): StoredResponsesItem => ({
  id,
  apiKeyId: 'key-a',
  payload: { item: { type: 'message', id, role: 'assistant', content: [] } },
  contentHash: `hash-${id}`,
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
  await repo.apiKeys.save(key(now));

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

  await sweepExpirations(now);

  expect((await db.prepare('SELECT COUNT(*) AS count FROM responses_items WHERE refreshed_at < ?').bind(now).first<{ count: number }>())?.count).toBe(0);
  expect((await db.prepare('SELECT COUNT(*) AS count FROM dump_records WHERE created_at < ?').bind(now).first<{ count: number }>())?.count).toBe(0);
  expect(await repo.responsesItems.lookupMany('key-a', ['msg-current'], 0)).toHaveLength(1);
  expect((await dumps.list('key-a', { limit: 10 })).map(row => row.id)).toEqual(['01K00000000000000000LIVE']);
});

test('a concurrent schedule wins over stale completion', async () => {
  const db = await createSqliteTestDb();
  const repo = new SqlRepo(db);
  await repo.expirationSweeps.schedule('responses', 'key-race', 0);
  const claim = await repo.expirationSweeps.claim('claim-race', 10, 0);
  if (claim === null) throw new Error('expected expiration claim');

  await repo.expirationSweeps.schedule('responses', 'key-race', 0);
  await repo.expirationSweeps.complete('claim-race', claim.revision, 10_000);

  const row = await db.prepare(
    "SELECT due_at, claim_token FROM expiration_sweeps WHERE domain = 'responses' AND key_id = 'key-race'",
  ).first<{ due_at: number; claim_token: string | null }>();
  expect(row).toEqual({ due_at: 0, claim_token: null });
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
    db.run("DELETE FROM dump_records WHERE key_id = 'key-old-dump'");
    expect(db.exec("SELECT file_key, owner_kind, state FROM spilled_files WHERE owner_key = json_array('key-old-dump', '01K00000000000000000OLD0')")[0].values)
      .toEqual([['dumps/v1/key-old-dump/old.req.gz', 'dump-request', 'retired']]);
  } finally {
    db.close();
  }
});
