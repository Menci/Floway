import { DatabaseSync } from 'node:sqlite';

import { expect, test } from 'vitest';

import { migrationSqlByFilename } from '../repo/test-sqlite.ts';

const migration = '0098_chatgpt_provider.sql';

test('migrates ChatGPT upstreams without changing their state or other upstreams', () => {
  const db = new DatabaseSync(':memory:');
  for (const [filename, sql] of migrationSqlByFilename) {
    if (filename === migration) {
      db.exec(`
        INSERT INTO upstreams (id, provider, name, created_at, updated_at, config_json, state_json, hue, config_version, usage_refresh_interval_minutes)
        VALUES ('account', 'codex', 'Account', 'created', 'updated', '{"accounts":[{"chatgptAccountId":"account"}]}', '{"accounts":[{"refresh_token":"secret"}]}', 294, 7, 15),
               ('other', 'custom', 'Other', 'created', 'updated', '{}', NULL, 42, 3, 5);
      `);
    }
    db.exec(sql);
  }
  expect(db.prepare('SELECT id, provider, config_json, state_json, hue, config_version, usage_refresh_interval_minutes FROM upstreams ORDER BY id').all()).toEqual([
    { id: 'account', provider: 'chatgpt', config_json: '{"accounts":[{"chatgptAccountId":"account"}]}', state_json: '{"accounts":[{"refresh_token":"secret"}]}', hue: 294, config_version: 7, usage_refresh_interval_minutes: 15 },
    { id: 'other', provider: 'custom', config_json: '{}', state_json: null, hue: 42, config_version: 3, usage_refresh_interval_minutes: 5 },
  ]);
  expect(() => db.prepare("UPDATE upstreams SET provider = 'codex' WHERE id = 'account'").run()).toThrow();
  expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_upstreams_sort', 'idx_upstreams_provider_enabled_sort') ORDER BY name").all()).toEqual([
    { name: 'idx_upstreams_provider_enabled_sort' }, { name: 'idx_upstreams_sort' },
  ]);
  db.close();
});
