import initSqlJs from 'sql.js';
import { test } from 'vitest';

import { migrationSqlByFilename } from './test-sqlite.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('0053 renames persisted model pricing metadata and clears the derived model cache', async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  for (const [filename, sql] of migrationSqlByFilename) {
    if (filename === '0053_model_pricing.sql') {
      const legacyKey = ['co', 'st'].join('');
      const configJson = JSON.stringify({
        models: [
          {
            upstreamModelId: 'priced',
            [legacyKey]: {
              input: 1,
              output: 4,
              tiers: { priority: { input: 2, output: 8 } },
            },
          },
          { upstreamModelId: 'unpriced' },
        ],
      });
      const cacheJson = JSON.stringify([{ id: 'cached', [legacyKey]: { input: 1 } }]);
      db.run(
        `INSERT INTO upstreams (id, provider, name, created_at, updated_at, config_json)
         VALUES ('up_pricing', 'custom', 'Pricing migration', '2026-07-13T00:00:00.000Z', '2026-07-13T00:00:00.000Z', ?)`,
        [configJson],
      );
      db.run(
        "INSERT INTO models_cache (upstream_id, fetched_at, models_json) VALUES ('up_pricing', 1, ?)",
        [cacheJson],
      );
    }
    db.run(sql);
  }

  const [configResult] = db.exec("SELECT config_json FROM upstreams WHERE id = 'up_pricing'");
  const config = JSON.parse(configResult!.values[0]![0] as string) as {
    models: { upstreamModelId: string; pricing?: unknown }[];
  };
  assertEquals(config, {
    models: [
      {
        upstreamModelId: 'priced',
        pricing: {
          entries: [
            { rates: { input: 1, output: 4 } },
            { selector: { serviceTier: 'priority' }, rates: { input: 2, output: 8 } },
          ],
        },
      },
      { upstreamModelId: 'unpriced' },
    ],
  });
  assertEquals(db.exec('SELECT COUNT(*) FROM models_cache')[0]!.values, [[0]]);
});
