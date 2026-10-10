import { expect, test } from 'vitest';

import { SqlRepo } from '../../src/repo/sql.ts';
import { createSqlJsDatabase, migrationSqlByFilename, wrapSqlJsDatabase } from '../repo/test-sqlite.ts';

const PRE_MIGRATION_CATALOG_REVISION = 12;

test('config-version migration preserves cached models and gives existing failures one retry count', async () => {
  const db = await createSqlJsDatabase();
  for (const [filename, sql] of migrationSqlByFilename) {
    if (filename >= '0085_upstream_config_version.sql') break;
    db.run(sql);
  }
  const cache = {
    revision: PRE_MIGRATION_CATALOG_REVISION,
    fetchedAt: 100,
    models: [],
    lastError: { message: 'existing failure', at: 200 },
  };
  db.run(`INSERT INTO upstreams
    (id, provider, name, enabled, sort_order, created_at, updated_at, config_json, state_json, flag_overrides, models_cache_json, hue)
    VALUES (?, 'custom', 'Before migration', 1, 0, '', '', ?, NULL, '{}', ?, 210)`, [
    'up_legacy_failure',
    JSON.stringify({ baseUrl: 'https://example.com', authStyle: 'none', endpoints: {}, ingressHeadersRules: [], modelsFetch: { enabled: false }, models: [] }),
    JSON.stringify(cache),
  ]);
  const migration = migrationSqlByFilename.find(([filename]) => filename === '0085_upstream_config_version.sql');
  if (!migration) throw new Error('config version migration missing');
  db.run(migration[1]);
  for (const [filename, sql] of migrationSqlByFilename) {
    if (filename > migration[0]) db.run(sql);
  }

  const record = await new SqlRepo(wrapSqlJsDatabase(db)).upstreams.getById('up_legacy_failure');
  expect(record?.configVersion).toBe(1);
  expect(record?.modelsCache).toBeNull();

  const cacheJson = db.exec("SELECT models_cache_json FROM upstreams WHERE id = 'up_legacy_failure'")[0]?.values[0]?.[0];
  if (typeof cacheJson !== 'string') throw new Error('Migrated models cache missing');
  expect(JSON.parse(cacheJson)).toMatchObject({
    revision: PRE_MIGRATION_CATALOG_REVISION,
    fetchedAt: 100,
    models: [],
    lastError: { message: 'existing failure', at: 200, failureCount: 1 },
  });
});
