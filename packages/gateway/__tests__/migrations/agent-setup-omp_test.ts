import { DatabaseSync } from 'node:sqlite';

import { expect, test } from 'vitest';

import { migrationSqlByFilename } from '../repo/test-sqlite.ts';
import { agentSetupConfigurationSchema } from '@floway-dev/agent-setup';

test('migration 0086 adds omp model and provider preferences without changing lease state', () => {
  const db = new DatabaseSync(':memory:');
  try {
    for (const [filename, sql] of migrationSqlByFilename) {
      if (filename === '0086_agent_setup_omp.sql') break;
      db.exec(sql);
    }
    const preferences = { apiKeyId: 'selected-key', codex: { model: 'selected-model', reasoningEffort: 'high' } };
    const selected = { ...preferences, omp: { model: 'existing-choice' } };
    const named = { ...preferences, omp: { model: 'named-choice', provider: 'personal' } };
    const configured = { ...preferences, omp: { model: 'configured', provider: 'configured', retry: { enabled: false, maxRetries: 7 } } };
    const partialRetry = { ...preferences, omp: { model: null, provider: 'partial', retry: { enabled: true } } };
    const insert = db.prepare(`INSERT INTO agent_setup
      (token, user_id, configuration_json, configuration_revision, expires_at, created_at, updated_at)
      VALUES (?, 1, ?, 7, 9000, 100, 200)`);
    for (const [token, value] of [['missing', preferences], ['selected', selected], ['named', named], ['configured', configured], ['partial', partialRetry]] as const) insert.run(token, JSON.stringify(value));
    const migration = migrationSqlByFilename.find(([filename]) => filename === '0086_agent_setup_omp.sql');
    if (migration === undefined) throw new Error('Missing migration 0086');
    db.exec(migration[1]);
    const rows = db.prepare('SELECT * FROM agent_setup ORDER BY token').all() as { token: string; configuration_json: string; configuration_revision: number; expires_at: number; created_at: number; updated_at: number }[];
    const values = Object.fromEntries(rows.map(row => [row.token, JSON.parse(row.configuration_json)]));
    expect(values.missing).toEqual({ ...preferences, omp: { model: null, provider: 'floway', retry: { enabled: null, maxRetries: null } } });
    expect(values.selected).toEqual({ ...preferences, omp: { model: 'existing-choice', provider: 'floway', retry: { enabled: null, maxRetries: null } } });
    expect(values.named).toEqual({ ...named, omp: { ...named.omp, retry: { enabled: null, maxRetries: null } } });
    expect(values.configured).toEqual(configured);
    expect(values.partial.omp.retry).toEqual({ enabled: true, maxRetries: null });
    for (const value of Object.values(values)) expect(agentSetupConfigurationSchema.shape.omp.safeParse(value.omp).success).toBe(true);
    for (const row of rows) expect(row).toMatchObject({ configuration_revision: 7, expires_at: 9000, created_at: 100, updated_at: 200 });
    db.exec(migration[1]);
    expect(db.prepare('SELECT configuration_json FROM agent_setup ORDER BY token').all()).toEqual(rows.map(row => ({ configuration_json: row.configuration_json })));
  } finally {
    db.close();
  }
});
