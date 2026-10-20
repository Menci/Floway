import { DatabaseSync } from 'node:sqlite';

import { expect, test } from 'vitest';

import { migrationSqlByFilename } from '../repo/test-sqlite.ts';

test('the upstream order migration replaces duplicate sparse values with stable ranks', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const filename = '0097_normalize_upstream_sort_order.sql';
    for (const [name, sql] of migrationSqlByFilename) {
      if (name === filename) break;
      db.exec(sql);
    }
    const insert = db.prepare(`INSERT INTO upstreams
      (id, provider, name, sort_order, created_at, updated_at, config_json, flag_overrides,
       disabled_public_model_ids, proxy_fallback_list_json, hue)
      VALUES (?, 'custom', ?, ?, ?, ?, '{}', '{}', '[]', '[]', 210)`);
    insert.run('later-id', 'Later ID', 10, '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
    insert.run('b', 'B', 10, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    insert.run('a', 'A', 10, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    insert.run('first', 'First', -5, '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z');

    const migration = migrationSqlByFilename.find(([name]) => name === filename);
    if (migration === undefined) throw new Error('Missing upstream order migration');
    db.exec(migration[1]);

    expect(db.prepare('SELECT id, sort_order FROM upstreams ORDER BY sort_order').all()).toEqual([
      { id: 'first', sort_order: 0 },
      { id: 'a', sort_order: 1 },
      { id: 'b', sort_order: 2 },
      { id: 'later-id', sort_order: 3 },
    ]);
  } finally {
    db.close();
  }
});
