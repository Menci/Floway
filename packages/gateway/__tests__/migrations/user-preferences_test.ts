import { DatabaseSync } from 'node:sqlite';

import { test } from 'vitest';

import { migrationSqlByFilename } from '../repo/test-sqlite.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('the preferences migration adds a per-user table without touching existing users', () => {
  const db = new DatabaseSync(':memory:');
  for (const [, sql] of migrationSqlByFilename) {
    db.exec(sql);
  }

  db.prepare("INSERT INTO user_preferences (user_id, preferences_json, updated_at) VALUES (1, '{\"quotaDisplay\":\"used\",\"language\":\"zh-Hans\"}', '')").run();
  const row = db.prepare('SELECT user_id, preferences_json FROM user_preferences').get() as { user_id: number; preferences_json: string };
  const users = db.prepare('SELECT id, username FROM users').all();
  db.close();

  assertEquals(row, { user_id: 1, preferences_json: '{"quotaDisplay":"used","language":"zh-Hans"}' });
  assertEquals(users, [{ id: 1, username: 'admin' }]);
});
