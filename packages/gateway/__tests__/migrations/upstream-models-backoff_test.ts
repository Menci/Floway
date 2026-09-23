import { expect, test } from 'vitest';

import { MODEL_CATALOG_REVISION } from '../../src/repo/models-cache-contract.ts';
import { SqlRepo } from '../../src/repo/sql.ts';
import { createSqlJsDatabase, migrationSqlByFilename, wrapSqlJsDatabase } from '../repo/test-sqlite.ts';

test('config-version migration preserves cached models and gives existing failures one retry count', async () => {
  const db = await createSqlJsDatabase();
  for (const [filename, sql] of migrationSqlByFilename) {
    if (filename >= '0085_upstream_config_version.sql') break;
    db.run(sql);
  }
  const cache = {
    revision: MODEL_CATALOG_REVISION,
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

  const record = await new SqlRepo(wrapSqlJsDatabase(db)).upstreams.getById('up_legacy_failure');
  expect(record?.configVersion).toBe(1);
  expect(record?.modelsCache).toMatchObject({
    revision: MODEL_CATALOG_REVISION,
    fetchedAt: 100,
    models: [],
    lastError: { message: 'existing failure', at: 200, failureCount: 1 },
  });
});
