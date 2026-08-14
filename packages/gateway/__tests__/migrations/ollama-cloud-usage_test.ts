import { DatabaseSync } from 'node:sqlite';

import { test } from 'vitest';

import { migrationSqlByFilename } from '../repo/test-sqlite.ts';
import { assertEquals } from '@floway-dev/test-utils';

const MIGRATION = '0078_ollama_cloud_usage.sql';

test('the Ollama cloud-usage migration turns the option on for ollama.com and off for everything else', () => {
  const db = new DatabaseSync(':memory:');
  for (const [filename, sql] of migrationSqlByFilename) {
    if (filename === MIGRATION) {
      const insert = db.prepare(`
        INSERT INTO upstreams (id, provider, name, created_at, updated_at, config_json, hue)
        VALUES (?, ?, ?, '', '', ?, 210)
      `);
      insert.run('cloud', 'ollama', 'Cloud', JSON.stringify({ baseUrl: 'https://ollama.com', apiKey: 'k', models: [] }));
      insert.run('cloud-path', 'ollama', 'Cloud path', JSON.stringify({ baseUrl: 'https://ollama.com/', apiKey: 'k', models: [] }));
      insert.run('daemon', 'ollama', 'Daemon', JSON.stringify({ baseUrl: 'http://127.0.0.1:11434', models: [] }));
      insert.run('mirror', 'ollama', 'Mirror', JSON.stringify({ baseUrl: 'https://ollama.example.com', apiKey: 'k', models: [] }));
      insert.run('chosen', 'ollama', 'Chosen', JSON.stringify({ baseUrl: 'https://ollama.example.com', apiKey: 'k', cloudUsage: true, models: [] }));
      insert.run('other', 'azure', 'Azure', JSON.stringify({ endpoint: 'https://resource.openai.azure.com/openai/v1', models: [] }));
    }
    db.exec(sql);
  }

  const rows = db.prepare('SELECT id, config_json AS config FROM upstreams ORDER BY id').all() as { id: string; config: string }[];
  db.close();
  const cloudUsageById = Object.fromEntries(rows.map(row => [row.id, (JSON.parse(row.config) as { cloudUsage?: boolean }).cloudUsage]));

  assertEquals(cloudUsageById, {
    'chosen': true,
    'cloud': true,
    'cloud-path': true,
    'daemon': false,
    'mirror': false,
    // A non-Ollama upstream has no such option and is left untouched.
    'other': undefined,
  });
});
