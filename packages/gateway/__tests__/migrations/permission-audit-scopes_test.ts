import { DatabaseSync } from 'node:sqlite';

import { expect, test } from 'vitest';

import { migrationSqlByFilename } from '../repo/test-sqlite.ts';

test('the permission audit migration splits legacy /Users rules across users and groups', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const filename = '0094_permission_audit_scopes.sql';
    for (const [name, sql] of migrationSqlByFilename) {
      if (name === filename) break;
      db.exec(sql);
    }
    db.prepare(`INSERT INTO access_records
      (principal_type, principal_id, scope_json, scope_key, sort_order, values_json, created_at, updated_at)
      VALUES ('user', 2, '{"kind":"users"}', 'users', 0, '{"User.Audit":true}', '2026-01-01', '2026-01-01')`).run();

    const migration = migrationSqlByFilename.find(([name]) => name === filename);
    if (migration === undefined) throw new Error('Missing permission audit scope migration');
    db.exec(migration[1]);

    expect(db.prepare("SELECT scope_key, scope_json, values_json FROM access_records WHERE scope_key IN ('users', 'groups') ORDER BY scope_key").all()).toEqual([
      { scope_key: 'groups', scope_json: '{"kind":"groups"}', values_json: '{"User.Audit":true}' },
      { scope_key: 'users', scope_json: '{"kind":"users"}', values_json: '{"User.Audit":true}' },
    ]);
  } finally {
    db.close();
  }
});
