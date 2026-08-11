import { expect, test } from 'vitest';

import { createSqliteTestDb, createSqlJsDatabase, migrationSqlByFilename, wrapSqlJsDatabase } from './test-sqlite.ts';
import { initDumpStore } from '../../src/dump/registry.ts';
import { FileDumpStore } from '../../src/repo/dump-store.ts';
import { initRepo } from '../../src/repo/index.ts';
import { SqlRepo } from '../../src/repo/sql.ts';
import { sweepExpirations } from '../../src/scheduled/expiration-sweeps.ts';
import { initFileStore, MemoryFileStore } from '@floway-dev/platform';

const integrityMigration = (): string => {
  const migration = migrationSqlByFilename.find(([filename]) => filename === '0082_expiration_sweep_integrity.sql');
  if (migration === undefined) throw new Error('missing migration 0082_expiration_sweep_integrity.sql');
  return migration[1];
};

const createPreIntegrityDatabase = async () => {
  const raw = await createSqlJsDatabase();
  for (const [filename, sql] of migrationSqlByFilename) {
    if (filename === '0082_expiration_sweep_integrity.sql') break;
    raw.run(sql);
  }
  return { raw, db: wrapSqlJsDatabase(raw) };
};

const insertApiKey = (raw: Awaited<ReturnType<typeof createSqlJsDatabase>>, id: string): void => {
  const serverSecret = [...id]
    .map(character => character.charCodeAt(0).toString(16))
    .join('')
    .padEnd(64, '0')
    .slice(0, 64);
  raw.run(
    `INSERT INTO api_keys
     (id, user_id, name, key, created_at, upstream_ids, deleted_at,
      dump_retention_seconds, server_secret, responses_retention_seconds)
     VALUES (?, 1, ?, ?, '2026-01-01T00:00:00Z', NULL, NULL, 3600, ?, 86400)`,
    [id, id, `raw-${id}`, serverSecret],
  );
};

const insertDump = (raw: Awaited<ReturnType<typeof createSqlJsDatabase>>, keyId: string, id: string): void => {
  raw.run(
    `INSERT INTO dump_records
     (key_id, id, created_at, upstream_id, meta_json, request_headers_json,
      response_headers_json, request_body_descriptor, response_body_descriptor)
     VALUES (?, ?, 1, NULL, '{}', '[]', NULL, NULL, NULL)`,
    [keyId, id],
  );
};

test('migration repairs missing coverage without disturbing existing sweeps', async () => {
  const { raw } = await createPreIntegrityDatabase();
  try {
    for (const id of ['dump-missing', 'responses-missing', 'existing', 'empty']) insertApiKey(raw, id);
    insertDump(raw, 'dump-missing', 'dump-a');
    raw.run(
      `INSERT INTO responses_items
       (id, api_key_id, payload_json, item_hash, payload_hash, payload_file_key, refreshed_at)
       VALUES ('item-a', 'responses-missing', '{}', 'item-hash', 'payload-hash', NULL, 0)`,
    );
    raw.run(
      `INSERT INTO responses_snapshots (id, api_key_id, item_ids_json, refreshed_at)
       VALUES ('snapshot-a', 'responses-missing', '[]', 0)`,
    );
    insertDump(raw, 'existing', 'dump-existing');
    raw.run(
      `UPDATE expiration_sweeps
       SET due_at = 999, revision = 7, claim_token = 'held', claimed_at = 123
       WHERE domain = 'dumps' AND key_id = 'existing'`,
    );
    raw.run("DELETE FROM expiration_sweeps WHERE key_id IN ('dump-missing', 'responses-missing')");

    raw.run(integrityMigration());

    expect(raw.exec(
      `SELECT domain, key_id, due_at, revision, claim_token, claimed_at
       FROM expiration_sweeps ORDER BY domain, key_id`,
    )[0].values).toEqual([
      ['dumps', 'dump-missing', 0, 0, null, null],
      ['dumps', 'existing', 999, 7, 'held', 123],
      ['responses', 'responses-missing', 0, 0, null, null],
    ]);
  } finally {
    raw.close();
  }
});

test('queue rows cannot be removed before their domain rows', async () => {
  const { raw } = await createPreIntegrityDatabase();
  try {
    insertApiKey(raw, 'both');
    insertDump(raw, 'both', 'dump-a');
    raw.run(
      `INSERT INTO responses_items
       (id, api_key_id, payload_json, item_hash, payload_hash, payload_file_key, refreshed_at)
       VALUES ('item-a', 'both', '{}', 'item-hash', 'payload-hash', NULL, 0)`,
    );
    raw.run(integrityMigration());

    expect(() => raw.run("DELETE FROM expiration_sweeps WHERE domain = 'dumps' AND key_id = 'both'"))
      .toThrow('expiration sweep cannot be removed while stored rows remain');
    expect(() => raw.run("DELETE FROM expiration_sweeps WHERE domain = 'responses' AND key_id = 'both'"))
      .toThrow('expiration sweep cannot be removed while stored rows remain');

    raw.run("DELETE FROM dump_records WHERE key_id = 'both'");
    raw.run("DELETE FROM expiration_sweeps WHERE domain = 'dumps' AND key_id = 'both'");
    expect(raw.exec("SELECT domain FROM expiration_sweeps WHERE key_id = 'both'")[0].values)
      .toEqual([['responses']]);

    raw.run("DELETE FROM responses_items WHERE api_key_id = 'both'");
    raw.run("DELETE FROM expiration_sweeps WHERE domain = 'responses' AND key_id = 'both'");
    expect(raw.exec("SELECT domain FROM expiration_sweeps WHERE key_id = 'both'")).toEqual([]);
  } finally {
    raw.close();
  }
});

test('drained completion cannot remove a queue whose domain still has rows', async () => {
  const db = await createSqliteTestDb();
  const repo = new SqlRepo(db);
  await repo.apiKeys.save({
    id: 'key-a',
    userId: 1,
    name: 'Key A',
    key: 'raw-key-a',
    serverSecret: 'aa'.repeat(32),
    createdAt: '2026-01-01T00:00:00Z',
    upstreamIds: null,
    deletedAt: null,
    dumpRetentionSeconds: 3600,
    responsesRetentionSeconds: 0,
  });
  await db.prepare(
    `INSERT INTO dump_records
     (key_id, id, created_at, upstream_id, meta_json, request_headers_json,
      response_headers_json, request_body_descriptor, response_body_descriptor)
     VALUES ('key-a', 'dump-a', 1, NULL, '{}', '[]', NULL, NULL, NULL)`,
  ).run();
  await repo.expirationSweeps.schedule('dumps', 'key-a', 0);
  const first = await repo.expirationSweeps.claim('claim-a', 10, 0);
  if (first === null) throw new Error('expected first expiration claim');

  await expect(repo.expirationSweeps.complete('claim-a', first.revision, { kind: 'drained', nextDueAt: null }))
    .rejects.toThrow('expiration sweep cannot be removed while stored rows remain');
  await repo.expirationSweeps.complete('claim-a', first.revision, { kind: 'partial', retryAt: 12 });
  expect(await db.prepare(
    "SELECT due_at, claim_token FROM expiration_sweeps WHERE domain = 'dumps' AND key_id = 'key-a'",
  ).first()).toEqual({ due_at: 12, claim_token: null });

  await db.prepare("DELETE FROM dump_records WHERE key_id = 'key-a'").run();
  const second = await repo.expirationSweeps.claim('claim-b', 12, 0);
  if (second === null) throw new Error('expected second expiration claim');
  await repo.expirationSweeps.complete('claim-b', second.revision, { kind: 'drained', nextDueAt: null });
  expect(await db.prepare("SELECT domain FROM expiration_sweeps WHERE key_id = 'key-a'").first()).toBeNull();
});

test('repaired inactive dump queues drain in bounded ticks', async () => {
  const { raw, db } = await createPreIntegrityDatabase();
  try {
    insertApiKey(raw, 'disabled');
    insertApiKey(raw, 'deleted');
    for (let index = 0; index < 75; index += 1) {
      insertDump(raw, 'disabled', `disabled-${index}`);
      insertDump(raw, 'deleted', `deleted-${index}`);
    }
    raw.run("UPDATE api_keys SET dump_retention_seconds = NULL WHERE id = 'disabled'");
    raw.run("UPDATE api_keys SET deleted_at = '2026-01-02T00:00:00Z' WHERE id = 'deleted'");
    raw.run("DELETE FROM expiration_sweeps WHERE domain = 'dumps'");
    raw.run(integrityMigration());

    const repo = new SqlRepo(db);
    initRepo(repo);
    const files = new MemoryFileStore();
    initFileStore(files);
    initDumpStore(new FileDumpStore(db, files));

    await sweepExpirations(Date.UTC(2026, 0, 3));
    expect((await db.prepare('SELECT COUNT(*) AS count FROM dump_records').first<{ count: number }>())?.count).toBe(50);
    await sweepExpirations(Date.UTC(2026, 0, 3, 0, 1));
    expect((await db.prepare('SELECT COUNT(*) AS count FROM dump_records').first<{ count: number }>())?.count).toBe(0);
    expect(await db.prepare("SELECT domain FROM expiration_sweeps WHERE domain = 'dumps'").first()).toBeNull();
  } finally {
    raw.close();
  }
});
