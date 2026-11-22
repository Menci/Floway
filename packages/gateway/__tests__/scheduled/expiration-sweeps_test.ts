import { afterEach, expect, test, vi } from 'vitest';

import { initDumpStore } from '../../src/dump/registry.ts';
import type { DumpMetadata } from '../../src/dump/types.ts';
import { FileDumpStore } from '../../src/repo/dump-store.ts';
import { initRepo } from '../../src/repo/index.ts';
import { OPENAI_RESPONSES_REFRESH_GRANULARITY_MS } from '../../src/repo/openai-responses-retention.ts';
import { SqlRepo } from '../../src/repo/sql.ts';
import type { ApiKey, StoredOpenAIResponsesItem } from '../../src/repo/types.ts';
import { sweepExpirations } from '../../src/scheduled/expiration-sweeps.ts';
import { createSqliteTestDb, createSqlJsDatabase, migrationSqlByFilename, wrapSqlJsDatabase } from '../repo/test-sqlite.ts';
import { initFileStore, MemoryFileStore } from '@floway-dev/platform';

afterEach(() => vi.useRealTimers());

const OPENAI_RESPONSES_RETENTION_SECONDS = 24 * 60 * 60;

const key = (now: number): ApiKey => ({
  id: 'key-a',
  userId: 1,
  name: 'Sweep key',
  key: 'raw-sweep-key',
  serverSecret: '55'.repeat(32),
  createdAt: new Date(now).toISOString(),
  upstreamIds: null,
  randomizeUpstreams: false,
  deletedAt: null,
  dumpRetentionSeconds: 3600,
  openaiResponsesRetentionSeconds: OPENAI_RESPONSES_RETENTION_SECONDS,
});

const responseItem = (id: string, refreshedAt: number, apiKeyId = 'key-a'): StoredOpenAIResponsesItem => ({
  id,
  apiKeyId,
  payload: { item: { type: 'message', id, role: 'assistant', content: [] } },
  itemHash: `hash-${id}`,
  refreshedAt,
});

const dumpRecord = (id: string, completedAt: number): DumpMetadata => ({
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
});

const putDump = async (store: FileDumpStore, keyId: string, meta: DumpMetadata): Promise<void> => {
  const artifactKey = store.createArtifactKey(keyId, meta.startedAt, meta.id);
  await store.stageAndPutArtifact(keyId, meta.id, artifactKey, new ReadableStream({
    start(controller) { controller.close(); },
  }));
  await store.commitRecord(keyId, { meta, artifactKey });
};

test('one fair driver drains bounded OpenAI Responses and dump backlogs', async () => {
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
  await repo.apiKeys.save({ ...key(now), dumpRetentionSeconds: 7200, openaiResponsesRetentionSeconds: 2 * OPENAI_RESPONSES_RETENTION_SECONDS });

  const openaiResponsesExpiredAt = now - 2 * OPENAI_RESPONSES_REFRESH_GRANULARITY_MS - 1;
  const dumpExpiredAt = now - 3600_000 - 1;
  await repo.openaiResponsesItems.insertMany(
    Array.from({ length: 150 }, (_, index) => responseItem(`msg-expired-${index}`, openaiResponsesExpiredAt)),
    0,
  );
  await repo.openaiResponsesItems.insertMany([responseItem('msg-current', now)], 0);
  for (let index = 0; index < 150; index += 1) {
    await putDump(dumps, 'key-a', dumpRecord(`01K00000000000000000${String(index).padStart(4, '0')}`, dumpExpiredAt));
  }
  await putDump(dumps, 'key-a', dumpRecord('01K00000000000000000LIVE', now));
  await repo.apiKeys.update('key-a', { dumpRetentionSeconds: 3600, openaiResponsesRetentionSeconds: OPENAI_RESPONSES_RETENTION_SECONDS });

  await sweepExpirations(now);

  expect((await db.prepare("SELECT COUNT(*) AS count FROM responses_items WHERE id LIKE 'msg-expired-%'").first<{ count: number }>())?.count).toBe(50);
  expect((await db.prepare('SELECT COUNT(*) AS count FROM dump_records WHERE created_at < ?').bind(now).first<{ count: number }>())?.count).toBe(100);
  await sweepExpirations(now + 60_000);

  expect((await db.prepare("SELECT COUNT(*) AS count FROM responses_items WHERE id LIKE 'msg-expired-%'").first<{ count: number }>())?.count).toBe(0);
  expect((await db.prepare('SELECT COUNT(*) AS count FROM dump_records WHERE created_at < ?').bind(now).first<{ count: number }>())?.count).toBe(50);
  await sweepExpirations(now + 120_000);

  expect((await db.prepare('SELECT COUNT(*) AS count FROM dump_records WHERE created_at < ?').bind(now).first<{ count: number }>())?.count).toBe(0);
  expect(await repo.openaiResponsesItems.lookupMany('key-a', ['msg-current'], 0)).toHaveLength(1);
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
  await repo.apiKeys.save({ ...key(now), id: 'a-hot', key: 'raw-a-hot', serverSecret: '77'.repeat(32), openaiResponsesRetentionSeconds: 2 * OPENAI_RESPONSES_RETENTION_SECONDS });
  await repo.apiKeys.save({ ...key(now), id: 'b-small', key: 'raw-b-small', serverSecret: '88'.repeat(32), openaiResponsesRetentionSeconds: 2 * OPENAI_RESPONSES_RETENTION_SECONDS });
  const expiredAt = now - 2 * OPENAI_RESPONSES_REFRESH_GRANULARITY_MS - 1;
  await repo.openaiResponsesItems.insertMany(
    Array.from({ length: 450 }, (_, index) => responseItem(`msg-hot-${index}`, expiredAt, 'a-hot')),
    0,
  );
  await repo.openaiResponsesItems.insertMany([responseItem('msg-small', expiredAt, 'b-small')], 0);
  await repo.apiKeys.update('a-hot', { openaiResponsesRetentionSeconds: OPENAI_RESPONSES_RETENTION_SECONDS });
  await repo.apiKeys.update('b-small', { openaiResponsesRetentionSeconds: OPENAI_RESPONSES_RETENTION_SECONDS });

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

test('bounded cleanup backfill tracks rows whose API key was hard-deleted', async () => {
  const now = Date.UTC(2026, 6, 23, 12);
  const raw = await createSqlJsDatabase();
  try {
    for (const [, sql] of migrationSqlByFilename) {
      raw.run(sql);
    }
    raw.run(
      `INSERT INTO api_keys
       (id, user_id, name, key, created_at, upstream_ids, deleted_at, dump_retention_seconds, server_secret, responses_retention_seconds)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['key-a', 1, 'Sweep key', 'raw-sweep-key', new Date(now).toISOString(), null, null, 3600, '55'.repeat(32), OPENAI_RESPONSES_RETENTION_SECONDS],
    );
    const db = wrapSqlJsDatabase(raw);
    const recordId = '01K00000000000000000ORPH';
    const fileKey = `dumps/v2/key-a/1970010100/${recordId}.ndjson.gz`;
    await db.prepare(
      `INSERT INTO spilled_files (file_key, owner_kind, owner_key, state, collect_after)
       VALUES (?, 'dump-artifact', json_array('key-a', ?), 'staged', ?)`,
    ).bind(fileKey, recordId, now + 60_000).run();
    await db.prepare(
      `INSERT INTO dump_records (key_id, id, created_at, upstream_id, meta_json, artifact_key)
       VALUES ('key-a', ?, 1, NULL, '{}', ?)`,
    ).bind(recordId, fileKey).run();
    await db.prepare("DELETE FROM api_keys WHERE id = 'key-a'").run();
    await db.prepare(
      "UPDATE expiration_sweeps SET due_at = 3600002 WHERE domain = 'dumps' AND key_id = 'key-a'",
    ).run();
    await db.prepare('DELETE FROM spilled_files WHERE file_key = ?').bind(fileKey).run();
    await db.prepare("UPDATE cleanup_backfills SET next_rowid = 0, complete = 0 WHERE source = 'dump_records'").run();

    const repo = new SqlRepo(db);
    await repo.expirationSweeps.backfillCleanupTracking(500);
    expect(await db.prepare(
      "SELECT due_at FROM expiration_sweeps WHERE domain = 'dumps' AND key_id = 'key-a'",
    ).first<{ due_at: number }>()).toEqual({ due_at: 0 });
    expect(await db.prepare(
      'SELECT owner_kind, owner_key, state FROM spilled_files WHERE file_key = ?',
    ).bind(fileKey).first()).toEqual({
      owner_kind: 'dump-artifact',
      owner_key: JSON.stringify(['key-a', recordId]),
      state: 'owned',
    });
  } finally {
    raw.close();
  }
});
