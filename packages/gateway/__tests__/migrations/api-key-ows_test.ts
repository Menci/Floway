import { DatabaseSync } from 'node:sqlite';

import { test } from 'vitest';

import { upstreamRecordToJson } from '../../src/control-plane/upstreams/serialize.ts';
import { migrationSqlByFilename } from '../repo/test-sqlite.ts';
import type { UpstreamRecord } from '@floway-dev/provider';
import { assertEquals } from '@floway-dev/test-utils';

const MIGRATION = '0081_trim_api_key_ows.sql';

const record = (id: string, kind: UpstreamRecord['kind'], config: unknown): UpstreamRecord => ({
  id,
  kind,
  name: id,
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-08-06T00:00:00.000Z',
  updatedAt: '2026-08-06T00:00:00.000Z',
  config,
  state: null,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  modelsCache: null,
  hue: 210,
});

test('the API-key OWS migration canonicalizes every transport credential into the strict field-value contract', () => {
  const db = new DatabaseSync(':memory:');
  let migrationSql = '';
  for (const [filename, sql] of migrationSqlByFilename) {
    if (filename === MIGRATION) {
      migrationSql = sql;
      const insert = db.prepare(`
        INSERT INTO upstreams (id, provider, name, created_at, updated_at, config_json, hue)
        VALUES (?, ?, ?, '2026-08-06', '2026-08-06', ?, 210)
      `);
      insert.run('custom', 'custom', 'custom', JSON.stringify({
        baseUrl: 'https://custom.example.com',
        authStyle: 'bearer',
        apiKey: '\t custom key \t',
        endpoints: { chatCompletions: {} },
        ingressHeadersRules: [
          { key: 'x-route', value: ' \t configured \t' },
          { key: 'x-empty', value: ' \t ' },
          { key: 'x-internal', value: 'a \t b' },
          { key: 'x-delete', value: null },
        ],
        modelsFetch: { enabled: false },
        models: [],
      }));
      insert.run('azure', 'azure', 'azure', JSON.stringify({
        endpoint: 'https://example.openai.azure.com',
        apiKey: ' azure\tkey ',
        models: [{ upstreamModelId: 'chat', kind: 'chat', endpoints: { chatCompletions: {} } }],
      }));
      insert.run('ollama', 'ollama', 'ollama', JSON.stringify({
        baseUrl: 'https://ollama.example.com',
        apiKey: '\tollama key ',
        models: [],
      }));
      insert.run('ollama_blank', 'ollama', 'ollama_blank', JSON.stringify({
        baseUrl: 'https://ollama-blank.example.com',
        apiKey: ' \t ',
        models: [],
      }));
      insert.run('codex', 'codex', 'codex', JSON.stringify({ apiKey: ' untouched ', accounts: [] }));
    }
    db.exec(sql);
  }
  if (migrationSql === '') throw new Error(`Missing migration ${MIGRATION}`);
  db.exec(migrationSql);

  const rows = db.prepare('SELECT id, provider, config_json FROM upstreams ORDER BY id').all() as {
    id: string;
    provider: UpstreamRecord['kind'];
    config_json: string;
  }[];
  db.close();
  const configs = new Map(rows.map(row => [row.id, JSON.parse(row.config_json) as Record<string, unknown>]));

  assertEquals(configs.get('custom')?.apiKey, 'custom key');
  assertEquals(configs.get('custom')?.ingressHeadersRules, [
    { key: 'x-route', value: 'configured' },
    { key: 'x-empty', value: '' },
    { key: 'x-internal', value: 'a \t b' },
    { key: 'x-delete', value: null },
  ]);
  assertEquals(configs.get('azure')?.apiKey, 'azure\tkey');
  assertEquals(configs.get('ollama')?.apiKey, 'ollama key');
  assertEquals('apiKey' in configs.get('ollama_blank')!, false);
  assertEquals(configs.get('codex')?.apiKey, ' untouched ');

  for (const row of rows.filter(row => row.id !== 'codex')) {
    upstreamRecordToJson(record(row.id, row.provider, configs.get(row.id)));
  }
});
