import { DatabaseSync } from 'node:sqlite';

import { test } from 'vitest';

import { migrationSqlByFilename } from '../repo/test-sqlite.ts';
import { assertEquals } from '@floway-dev/test-utils';

const MIGRATION = '0079_copilot_seat_plan.sql';

// The token entry is a closed key set, so an entry minted while `sku` was
// persisted has to lose it here: the reader rejects the row otherwise.
test('the Copilot seat migration strips the token SKU and leaves the rest of the entry alone', () => {
  const db = new DatabaseSync(':memory:');
  const token = { token: 'tok', expiresAt: 2_000_000, baseUrl: 'https://api.individual.githubcopilot.com' };
  for (const [filename, sql] of migrationSqlByFilename) {
    if (filename === MIGRATION) {
      const insert = db.prepare(`
        INSERT INTO upstreams (id, provider, name, created_at, updated_at, config_json, state_json, hue)
        VALUES (?, ?, ?, '', '', '{}', ?, 210)
      `);
      insert.run('with-sku', 'copilot', 'With SKU', JSON.stringify({
        knownModels: null,
        copilotToken: { ...token, sku: 'monthly_subscriber_quota' },
        quotaSnapshot: null,
      }));
      insert.run('without-sku', 'copilot', 'Without SKU', JSON.stringify({ knownModels: null, copilotToken: token, quotaSnapshot: null }));
      insert.run('no-token', 'copilot', 'No token', JSON.stringify({ knownModels: null, copilotToken: null, quotaSnapshot: null }));
      insert.run('other', 'ollama', 'Ollama', JSON.stringify({ usageProbe: null }));
    }
    db.exec(sql);
  }

  const rows = db.prepare('SELECT id, state_json AS state FROM upstreams ORDER BY id').all() as { id: string; state: string }[];
  db.close();
  const stateById = Object.fromEntries(rows.map(row => [row.id, JSON.parse(row.state) as Record<string, unknown>]));

  assertEquals(stateById['with-sku'].copilotToken, token);
  assertEquals(stateById['without-sku'].copilotToken, token);
  assertEquals(stateById['no-token'].copilotToken, null);
  assertEquals(stateById.other, { usageProbe: null });
});
