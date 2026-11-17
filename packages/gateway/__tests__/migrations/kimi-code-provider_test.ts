import { DatabaseSync } from 'node:sqlite';

import { expect, test } from 'vitest';

import { migrationSqlByFilename } from '../repo/test-sqlite.ts';

test('the Kimi Code migration preserves upstream records and indexes while admitting subscription keys', () => {
  const db = new DatabaseSync(':memory:');
  for (const [filename, sql] of migrationSqlByFilename) {
    if (filename === '0099_kimi_code_provider.sql') db.exec(`
      INSERT INTO upstreams (id, provider, name, created_at, updated_at, config_json, state_json, hue, config_version, usage_refresh_interval_minutes)
      VALUES ('existing', 'custom', 'Existing', 'created', 'updated', '{}', '{"probe":"kept"}', 42, 3, 5);
    `);
    db.exec(sql);
  }
  expect(db.prepare('SELECT id, provider, state_json, hue, config_version, usage_refresh_interval_minutes FROM upstreams').all()).toEqual([
    { id: 'existing', provider: 'custom', state_json: '{"probe":"kept"}', hue: 42, config_version: 4, usage_refresh_interval_minutes: 5 },
  ]);
  db.prepare("INSERT INTO upstreams (id, provider, name, created_at, updated_at, config_json, hue) VALUES ('kimi', 'kimi-code', 'Kimi Code', 'created', 'updated', ?, 210)").run('{"region":"china","apiKey":"sk-kimi-fake-test-key"}');
  expect(db.prepare("SELECT provider FROM upstreams WHERE id = 'kimi'").get()).toEqual({ provider: 'kimi-code' });
  expect(() => db.prepare("UPDATE upstreams SET provider = 'unknown' WHERE id = 'kimi'").run()).toThrow();
  expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_upstreams_sort', 'idx_upstreams_provider_enabled_sort') ORDER BY name").all()).toEqual([
    { name: 'idx_upstreams_provider_enabled_sort' }, { name: 'idx_upstreams_sort' },
  ]);
  db.close();
});
