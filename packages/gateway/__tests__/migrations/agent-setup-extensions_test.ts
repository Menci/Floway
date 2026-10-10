import { DatabaseSync } from 'node:sqlite';

import { expect, test } from 'vitest';

import { migrationSqlByFilename } from '../repo/test-sqlite.ts';
import { agentSetupConfigurationSchema } from '@floway-dev/agent-setup';

test('the extension migration adds both clients and preserves existing preferences and lease state', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const filename = '0086_agent_setup_extensions.sql';
    for (const [name, sql] of migrationSqlByFilename) {
      if (name === filename) break;
      db.exec(sql);
    }
    const preferences = {
      apiKeyId: 'selected-key',
      codex: { model: 'selected-model', reasoningEffort: 'high' },
      claudeCode: {
        model: null, defaultFableModel: null, defaultOpusModel: null, defaultSonnetModel: null,
        defaultHaikuModel: null, effortLevel: null, cleanupPeriodDays: null, optOutAiAttribution: false,
        disableAutoMemory: false, disableAgentView: false, modelDiscovery: true,
      },
    };
    const pi = { model: null, provider: '', thinkingLevel: null, retry: { enabled: null, maxRetries: null } };
    const omp = { model: null, provider: '', retry: { enabled: null, maxRetries: null } };
    const defaults = { ...preferences, pi, omp };
    const fixtures = {
      defaults: preferences,
      selected: { ...preferences, codex: { model: 'custom-codex', reasoningEffort: 'low' }, claudeCode: { ...preferences.claudeCode, model: 'custom-claude' } },
    };
    const insert = db.prepare(`INSERT INTO agent_setup
      (token, user_id, configuration_json, configuration_revision, expires_at, created_at, updated_at)
      VALUES (?, 1, ?, 7, 9000, 100, 200)`);
    for (const [token, value] of Object.entries(fixtures)) insert.run(token, JSON.stringify(value));
    const migration = migrationSqlByFilename.find(([name]) => name === filename);
    if (migration === undefined) throw new Error('Missing extension migration');
    db.exec(migration[1]);
    const rows = db.prepare('SELECT * FROM agent_setup ORDER BY token').all() as { token: string; configuration_json: string; configuration_revision: number; expires_at: number; created_at: number; updated_at: number }[];
    const values = Object.fromEntries(rows.map(row => [row.token, JSON.parse(row.configuration_json)]));
    expect(values.defaults).toEqual(defaults);
    expect(values.selected).toEqual({ ...fixtures.selected, pi, omp });
    for (const value of Object.values(values)) expect(agentSetupConfigurationSchema.safeParse(value).success).toBe(true);
    for (const row of rows) expect(row).toMatchObject({ configuration_revision: 7, expires_at: 9000, created_at: 100, updated_at: 200 });
  } finally {
    db.close();
  }
});
