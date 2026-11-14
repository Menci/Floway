import { DatabaseSync } from 'node:sqlite';

import { test } from 'vitest';

import { migrationSqlByFilename } from '../repo/test-sqlite.ts';
import { assertEquals } from '@floway-dev/test-utils';

const MIGRATION = '0090_copilot_quota_unlimited.sql';

interface MigratedState {
  quotaSnapshot: null | { data: { quotas: Record<string, unknown> } };
}

const detail = (entitlement: number, unlimited: boolean) => ({
  entitlement,
  overage_count: 0,
  overage_permitted: false,
  percent_remaining: 100,
  quota_remaining: entitlement,
  unlimited,
});

test('the Copilot quota migration canonicalizes the unlimited sentinel without rewriting other quota values', () => {
  const db = new DatabaseSync(':memory:');
  const legacyQuotas = Object.fromEntries([
    ['__proto__', detail(-1, false)],
    ['quote"key', detail(-1, false)],
    ['missing_flag', { entitlement: -1, quota_remaining: -1 }],
    ['premium_interactions', detail(300, false)],
    ['invalid_negative', detail(-2, false)],
  ]);
  const canonicalQuotas = { chat: detail(-1, true) };
  for (const [filename, sql] of migrationSqlByFilename) {
    if (filename === MIGRATION) {
      const insert = db.prepare(`
        INSERT INTO upstreams (id, provider, name, created_at, updated_at, config_json, state_json, hue)
        VALUES (?, ?, ?, '', '', '{}', ?, 210)
      `);
      const state = (quotas: Record<string, unknown>) => JSON.stringify({
        knownModels: null,
        copilotToken: null,
        quotaSnapshot: { fetchedAt: 1, data: { observed_at: '2026-08-01T00:00:00.000Z', reset_at: null, quotas } },
        seat: null,
      });
      insert.run('legacy', 'copilot', 'Legacy', state(legacyQuotas));
      insert.run('canonical', 'copilot', 'Canonical', state(canonicalQuotas));
      insert.run('empty', 'copilot', 'Empty', JSON.stringify({ knownModels: null, copilotToken: null, quotaSnapshot: null, seat: null }));
      insert.run('other', 'custom', 'Other', state(legacyQuotas));
    }
    db.exec(sql);
  }

  const rows = db.prepare('SELECT id, state_json AS state FROM upstreams ORDER BY id').all() as { id: string; state: string }[];
  db.close();
  const stateById = Object.fromEntries(rows.map(row => [row.id, JSON.parse(row.state) as MigratedState])) as Record<string, MigratedState>;

  assertEquals(stateById.legacy.quotaSnapshot?.data.quotas, {
    ['__proto__']: detail(-1, true),
    ['quote"key']: detail(-1, true),
    missing_flag: { entitlement: -1, quota_remaining: -1, unlimited: true },
    premium_interactions: detail(300, false),
    invalid_negative: detail(-2, false),
  });
  assertEquals(stateById.canonical.quotaSnapshot?.data.quotas, canonicalQuotas);
  assertEquals(stateById.empty.quotaSnapshot, null);
  assertEquals(stateById.other.quotaSnapshot?.data.quotas, legacyQuotas);
});
