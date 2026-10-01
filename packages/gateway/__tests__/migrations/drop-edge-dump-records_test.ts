import { DatabaseSync } from 'node:sqlite';

import { expect, test } from 'vitest';

import { migrationSqlByFilename } from '../repo/test-sqlite.ts';

const MIGRATION = '0086_drop_edge_dump_records.sql';

test('deletes historical edge records and retires all their files while preserving run records', () => {
  const db = new DatabaseSync(':memory:');
  try {
    for (const [filename, sql] of migrationSqlByFilename) {
      if (filename === MIGRATION) break;
      db.exec(sql);
    }
    db.prepare(`INSERT INTO api_keys (id, user_id, name, key, created_at, server_secret, dump_retention_seconds)
      VALUES (?, 1, ?, ?, ?, ?, 3600)`).run('key', 'Migration key', 'migration-key', '2026-01-01T00:00:00Z', '44'.repeat(32));
    const stage = db.prepare(`INSERT INTO spilled_files (file_key, owner_kind, owner_key, state, collect_after)
      VALUES (?, ?, ?, 'staged', 10000)`);
    const insert = db.prepare(`INSERT INTO dump_records
      (key_id, id, created_at, meta_json, request_headers_json, request_body_descriptor, response_body_descriptor, response_upstream_body_descriptor)
      VALUES ('key', ?, 1000, '{}', '[]', ?, ?, ?)`);
    const file = (id: string, part: 'request' | 'response' | 'response-upstream', type: string) => {
      const key = `dumps/v1/key/${id}-${part}.gz`;
      stage.run(key, `dump-${part}`, JSON.stringify(['key', id]));
      return JSON.stringify({ key, type });
    };
    insert.run('edge-bytes', file('edge-bytes', 'request', 'bytes'), file('edge-bytes', 'response', 'bytes'), file('edge-bytes', 'response-upstream', 'events'));
    insert.run('edge-events', null, file('edge-events', 'response', 'events'), null);
    insert.run('edge-empty', file('edge-empty', 'request', 'bytes'), null, null);
    insert.run('retained-run', null, file('retained-run', 'response', 'run'), null);

    expect(db.prepare('SELECT id FROM dump_records ORDER BY id').all()).toEqual([
      { id: 'edge-bytes' }, { id: 'edge-empty' }, { id: 'edge-events' }, { id: 'retained-run' },
    ]);
    expect(db.prepare('SELECT DISTINCT state, collect_after FROM spilled_files').all()).toEqual([{ state: 'owned', collect_after: null }]);

    const retainedRun = db.prepare("SELECT * FROM dump_records WHERE id = 'retained-run'").get();
    const migration = migrationSqlByFilename.find(([filename]) => filename === MIGRATION)!;
    db.exec(migration[1]);

    expect(db.prepare('SELECT id FROM dump_records').all()).toEqual([{ id: 'retained-run' }]);
    expect(db.prepare("SELECT * FROM dump_records WHERE id = 'retained-run'").get()).toEqual(retainedRun);
    expect(db.prepare('SELECT file_key, state, collect_after FROM spilled_files WHERE owner_key != ? ORDER BY file_key')
      .all(JSON.stringify(['key', 'retained-run']))).toEqual([
      { file_key: 'dumps/v1/key/edge-bytes-request.gz', state: 'retired', collect_after: 0 },
      { file_key: 'dumps/v1/key/edge-bytes-response-upstream.gz', state: 'retired', collect_after: 0 },
      { file_key: 'dumps/v1/key/edge-bytes-response.gz', state: 'retired', collect_after: 0 },
      { file_key: 'dumps/v1/key/edge-empty-request.gz', state: 'retired', collect_after: 0 },
      { file_key: 'dumps/v1/key/edge-events-response.gz', state: 'retired', collect_after: 0 },
    ]);
    expect(db.prepare('SELECT state, collect_after FROM spilled_files WHERE owner_key = ?')
      .get(JSON.stringify(['key', 'retained-run']))).toEqual({ state: 'owned', collect_after: null });
  } finally { db.close(); }
});
