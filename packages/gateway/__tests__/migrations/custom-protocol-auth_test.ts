import { DatabaseSync } from 'node:sqlite';

import { expect, test } from 'vitest';

import { decodeUpstreamConfig } from '../../src/repo/upstream-codecs.ts';
import { migrationSqlByFilename } from '../repo/test-sqlite.ts';
import type { UpstreamRecord } from '@floway-dev/provider';
import { assertCustomUpstreamRecord } from '@floway-dev/provider-custom';

const MIGRATION = '0100_custom_protocol_auth.sql';

const migratedConfigs = (runMigration: boolean): Record<string, unknown> => {
  const db = new DatabaseSync(':memory:');
  for (const [filename, sql] of migrationSqlByFilename) {
    if (filename === MIGRATION) {
      db.prepare(`
        INSERT INTO upstreams (id, provider, name, created_at, updated_at, config_json, hue, config_version)
        VALUES
          ('up_none', 'custom', 'None', '', '', '{"baseUrl":"https://none.example","authStyle":"none","endpoints":{},"ingressHeadersRules":[]}', 210, 4),
          ('up_bearer', 'custom', 'Bearer', '', '', '{"baseUrl":"https://bearer.example","authStyle":"bearer","apiKey":"sk-bearer","modelsFetch":{"enabled":false},"endpoints":{},"ingressHeadersRules":[]}', 210, 5),
          ('up_models_fetch_override', 'custom', 'Fetch override', '', '', '{"baseUrl":"https://override.example","authStyle":"bearer","apiKey":"sk-override","modelsFetch":{"enabled":true,"authStyle":"anthropic"},"endpoints":{},"ingressHeadersRules":[]}', 210, 6),
          ('up_missing', 'custom', 'Missing', '', '', '{"baseUrl":"https://missing.example","endpoints":{},"ingressHeadersRules":[]}', 210, 7),
          ('up_unrelated', 'azure', 'Azure', '', '', '{"endpoint":"https://azure.example","apiKey":"az-key","models":[]}', 210, 8)
      `).run();
      if (!runMigration) continue;
    }
    db.exec(sql);
  }
  const rows = db.prepare('SELECT id, config_json AS config, config_version AS version FROM upstreams').all() as { id: string; config: string; version: number }[];
  db.close();
  return Object.fromEntries(rows.map(row => [row.id, { config: decodeUpstreamConfig(row.config, row.id), version: row.version }]));
};

test('migration 0100 moves authStyle into modelsFetch and stores anonymous custom upstreams as an empty API key', () => {
  const rows = migratedConfigs(true) as Record<string, { config: unknown; version: number }>;
  for (const [id, expectedApiKey, expectedAuthStyle, expectedVersion] of [['up_none', '', 'none', 5], ['up_bearer', 'sk-bearer', 'bearer', 6], ['up_models_fetch_override', 'sk-override', 'anthropic', 7], ['up_missing', '', 'bearer', 8]] as const) {
    const parsed = assertCustomUpstreamRecord({ id, kind: 'custom', config: rows[id]!.config } as unknown as UpstreamRecord);
    expect(parsed.config.apiKey).toBe(expectedApiKey);
    expect(parsed.config.modelsFetch.authStyle).toBe(expectedAuthStyle);
    expect('authStyle' in parsed.config).toBe(false);
    expect(rows[id]!.version).toBe(expectedVersion);
  }
  const azure = rows.up_unrelated!;
  expect(azure.config).toEqual({ endpoint: 'https://azure.example', apiKey: 'az-key', models: [] });
  expect(azure.version).toBe(8);
});

test('without migration 0100 the removed authStyle still leaves anonymous rows unparseable', () => {
  const rows = migratedConfigs(false) as Record<string, { config: unknown; version: number }>;
  expect(() => assertCustomUpstreamRecord({ id: 'up_none', kind: 'custom', config: rows.up_none!.config } as unknown as UpstreamRecord)).toThrow(/apiKey must be a string/);
});
