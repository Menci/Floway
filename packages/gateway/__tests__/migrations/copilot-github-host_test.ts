import { DatabaseSync } from 'node:sqlite';

import { test } from 'vitest';

import { migrationSqlByFilename } from '../repo/test-sqlite.ts';
import { serializeStoredConfig } from '../../src/repo/upstream-json.ts';
import { assertEquals } from '@floway-dev/test-utils';

const MIGRATION = '0075_copilot_github_host.sql';

test('the Copilot GitHub host migration materializes github.com without overwriting an existing host', () => {
  const db = new DatabaseSync(':memory:');
  for (const [filename, sql] of migrationSqlByFilename) {
    if (filename === MIGRATION) {
      const insert = db.prepare(`
        INSERT INTO upstreams (id, provider, name, created_at, updated_at, config_json, hue)
        VALUES (?, 'copilot', ?, '', '', ?, 210)
      `);
      insert.run('legacy', 'Legacy', JSON.stringify({ githubToken: 'legacy-token', user: { id: 1 } }));
      insert.run('tenant', 'Tenant', JSON.stringify({ githubHost: 'octocorp.ghe.com', githubToken: 'tenant-token', user: { id: 2 } }));
    }
    db.exec(sql);
  }

  const rows = db.prepare('SELECT id, config_json AS config FROM upstreams ORDER BY id').all() as { id: string; config: string }[];
  db.close();
  const migratedLegacy = rows.find(row => row.id === 'legacy');
  if (!migratedLegacy) throw new Error('migrated legacy row missing');
  assertEquals(migratedLegacy.config === serializeStoredConfig(JSON.parse(migratedLegacy.config)), false);
  assertEquals(rows.map(row => ({ id: row.id, config: JSON.parse(row.config) })), [
    { id: 'legacy', config: { githubToken: 'legacy-token', user: { id: 1 }, githubHost: 'github.com' } },
    { id: 'tenant', config: { githubHost: 'octocorp.ghe.com', githubToken: 'tenant-token', user: { id: 2 } } },
  ]);
});
