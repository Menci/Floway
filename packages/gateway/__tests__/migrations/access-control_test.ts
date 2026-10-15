import { DatabaseSync } from 'node:sqlite';

import { test } from 'vitest';

import { migrationSqlByFilename } from '../repo/test-sqlite.ts';
import { assertEquals } from '@floway-dev/test-utils';

const MIGRATION = '0091_access_control.sql';

test('the access-control migration translates user upstream caps and grants self audit', () => {
  const db = new DatabaseSync(':memory:');
  for (const [filename, sql] of migrationSqlByFilename) {
    if (filename === MIGRATION) {
      const insert = db.prepare(
        `INSERT INTO users (id, username, password_hash, is_admin, upstream_ids, created_at, deleted_at)
         VALUES (?, ?, NULL, 0, ?, '2026-01-01T00:00:00.000Z', ?)`,
      );
      insert.run(2, 'all', null, null);
      insert.run(3, 'selected', JSON.stringify(['up_a', 'up_b']), null);
      insert.run(4, 'none', JSON.stringify([]), null);
      insert.run(5, 'deleted', null, '2026-01-02T00:00:00.000Z');
    }
    db.exec(sql);
  }

  const records = db.prepare(
    `SELECT principal_id, scope_json AS scope, sort_order AS sortOrder, values_json AS valuesJson
     FROM access_records WHERE principal_id BETWEEN 2 AND 5 ORDER BY principal_id, id`,
  ).all() as Array<{ principal_id: number; scope: string; sortOrder: number; valuesJson: string }>;
  assertEquals(records.map(record => ({
    principalId: record.principal_id,
    scope: JSON.parse(record.scope),
    sortOrder: record.sortOrder,
    values: JSON.parse(record.valuesJson),
  })), [
    { principalId: 2, scope: { kind: 'upstreams' }, sortOrder: 0, values: { 'Model.Use': true } },
    { principalId: 2, scope: { kind: 'user', userId: 2 }, sortOrder: 0, values: { 'User.Audit': true } },
    { principalId: 3, scope: { kind: 'upstream', upstreamId: 'up_a' }, sortOrder: 0, values: { 'Model.Use': true } },
    { principalId: 3, scope: { kind: 'upstream', upstreamId: 'up_b' }, sortOrder: 1, values: { 'Model.Use': true } },
    { principalId: 3, scope: { kind: 'user', userId: 3 }, sortOrder: 0, values: { 'User.Audit': true } },
    { principalId: 4, scope: { kind: 'user', userId: 4 }, sortOrder: 0, values: { 'User.Audit': true } },
  ]);
  const columns = db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>;
  assertEquals(columns.some(column => column.name === 'upstream_ids'), false);
  db.close();
});
