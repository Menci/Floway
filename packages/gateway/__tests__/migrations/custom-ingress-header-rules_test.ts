import { DatabaseSync } from 'node:sqlite';

import { test } from 'vitest';

import { migrationSqlByFilename } from '../repo/test-sqlite.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('the Custom ingress header migration backfills only missing Custom rule lists', () => {
  const db = new DatabaseSync(':memory:');
  for (const [filename, sql] of migrationSqlByFilename) {
    if (filename === '0076_custom_ingress_header_rules.sql') {
      const insert = db.prepare(`INSERT INTO upstreams (id, provider, name, created_at, updated_at, config_json, hue)
        VALUES (?, ?, 'test', '2026-01-01', '2026-01-01', ?, 210)`);
      insert.run('custom_missing', 'custom', JSON.stringify({ baseUrl: 'https://example.com' }));
      insert.run('custom_existing', 'custom', JSON.stringify({ ingressHeadersRules: [{ key: 'x-route', value: null }] }));
      insert.run('azure_missing', 'azure', JSON.stringify({ endpoint: 'https://example.com' }));
    }
    db.exec(sql);
  }

  const rows = db.prepare('SELECT id, config_json FROM upstreams ORDER BY id').all() as { id: string; config_json: string }[];
  db.close();
  const configs = Object.fromEntries(rows.map(row => [row.id, JSON.parse(row.config_json) as unknown]));
  assertEquals(configs, {
    azure_missing: { endpoint: 'https://example.com' },
    custom_existing: { ingressHeadersRules: [{ key: 'x-route', value: null }] },
    custom_missing: { baseUrl: 'https://example.com', ingressHeadersRules: [] },
  });
});
