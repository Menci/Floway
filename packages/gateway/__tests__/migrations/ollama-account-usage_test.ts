import { expect, test } from 'vitest';

import { createSqlJsDatabase, migrationSqlByFilename } from '../repo/test-sqlite.ts';

test('the Ollama account migration clears obsolete observations while preserving identity and other upstreams', async () => {
  const db = await createSqlJsDatabase();
  for (const [filename, sql] of migrationSqlByFilename) {
    if (filename >= '0088_ollama_account_usage.sql') break;
    db.run(sql);
  }
  const account = { fetchedAt: 1000, name: 'Tester', email: 'test@example.com', plan: 'pro' };
  const previous = { account, usageProbe: { attemptedAt: 1000, observation: { fetchedAt: 1000, data: { limits: { session: { usage: 0.25 } }, activity: { cost: '3.50' } } }, error: null } };
  for (const provider of ['ollama', 'custom']) db.run(`INSERT INTO upstreams
    (id, provider, name, enabled, sort_order, created_at, updated_at, config_json, state_json, flag_overrides, hue)
    VALUES (?, ?, 'Migration fixture', 1, 0, '', '', '{}', ?, '{}', 210)`, [provider, provider, JSON.stringify(previous)]);
  const migration = migrationSqlByFilename.find(([filename]) => filename === '0088_ollama_account_usage.sql');
  if (!migration) throw new Error('Ollama account migration missing');
  db.run(migration[1]);
  const rows = db.exec('SELECT id, state_json FROM upstreams ORDER BY id')[0]!.values;
  expect(JSON.parse(rows[0]![1] as string)).toEqual(previous);
  expect(JSON.parse(rows[1]![1] as string)).toEqual({ account, usageProbe: null });
  db.close();
});
