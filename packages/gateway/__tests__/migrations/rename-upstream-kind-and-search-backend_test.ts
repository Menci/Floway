import { DatabaseSync } from 'node:sqlite';

import { expect, test } from 'vitest';

import { decodeUpstreamModel } from '../../src/repo/upstream-codecs.ts';
import { migrationSqlByFilename } from '../repo/test-sqlite.ts';

const MIGRATION = '0103_rename_upstream_kind_and_search_backend.sql';

test('migration 0103 renames upstreams.kind, search_config/search_usage.backend, and upstream_models $.upstreamData', () => {
  const db = new DatabaseSync(':memory:');
  for (const [filename, sql] of migrationSqlByFilename) {
    if (filename === MIGRATION) {
      db.prepare(`
        INSERT INTO upstreams (id, provider, name, created_at, updated_at, config_json, hue)
        VALUES ('up_copilot', 'copilot', 'Copilot', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '{}', 210)
      `).run();

      const baseModel = {
        limits: {},
        kind: 'chat',
        endpoints: { openaiResponses: {} },
        opaqueBlobCompatibilityScope: { bindToUpstream: true },
        enabledFlags: [],
      };
      const samples = [
        ['m-obj', { ...baseModel, id: 'm-obj', upstreamModelId: 'm-obj', providerData: { rawModels: [{ id: 'a' }], fast: true } }],
        ['m-str', { ...baseModel, id: 'm-str', upstreamModelId: 'm-str', providerData: 'wire-id' }],
        ['m-bool', { ...baseModel, id: 'm-bool', upstreamModelId: 'm-bool', providerData: false }],
        ['m-arr', { ...baseModel, id: 'm-arr', upstreamModelId: 'm-arr', providerData: [1, 'x', null] }],
        ['m-null', { ...baseModel, id: 'm-null', upstreamModelId: 'm-null', providerData: null }],
        ['m-none', { ...baseModel, id: 'm-none', upstreamModelId: 'm-none' }],
      ] as const;
      const insertModel = db.prepare(`
        INSERT INTO upstream_models (upstream_id, model_id, kind, source, disabled, upstream_model_id, model_json)
        VALUES ('up_copilot', ?, 'chat', 'auto', 0, ?, ?)
      `);
      for (const [id, payload] of samples) {
        insertModel.run(id, id, JSON.stringify(payload));
      }

      db.prepare("UPDATE search_config SET provider = 'tavily', tavily_api_key = 'tvly-key' WHERE id = 1").run();
      db.prepare("INSERT INTO search_usage (provider, key_id, action, hour, requests) VALUES ('tavily', 'key_1', 'search', '2026-01-01T00', 7)").run();
    }
    db.exec(sql);
    if (filename === MIGRATION) break;
  }

  // upstreams.kind + index + CHECK constraint
  const upstreamRow = db.prepare("SELECT id, kind FROM upstreams WHERE id = 'up_copilot'").get() as { id: string; kind: string };
  expect(upstreamRow).toEqual({ id: 'up_copilot', kind: 'copilot' });
  expect(() => db.prepare("INSERT INTO upstreams (id, kind, name, created_at, updated_at, config_json, hue) VALUES ('bad', 'bogus', 'Bad', '', '', '{}', 0)").run()).toThrow();

  const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'upstreams'").all() as { name: string }[]).map(row => row.name);
  expect(indexes).toContain('idx_upstreams_kind_enabled_sort');
  expect(indexes).not.toContain('idx_upstreams_provider_enabled_sort');

  // upstream_models.model_json $.providerData -> $.upstreamData across JSON value types
  const modelRows = db.prepare('SELECT model_id, model_json FROM upstream_models ORDER BY model_id').all() as { model_id: string; model_json: string }[];
  const byId = new Map(modelRows.map(row => [row.model_id, decodeUpstreamModel(row.model_json, row.model_id)]));
  for (const row of modelRows) {
    expect('providerData' in (JSON.parse(row.model_json) as Record<string, unknown>)).toBe(false);
  }
  expect(byId.get('m-obj')?.upstreamData).toEqual({ rawModels: [{ id: 'a' }], fast: true });
  expect(byId.get('m-str')?.upstreamData).toBe('wire-id');
  expect(byId.get('m-bool')?.upstreamData).toBe(false);
  expect(byId.get('m-arr')?.upstreamData).toEqual([1, 'x', null]);
  expect(byId.get('m-null')?.upstreamData).toBeNull();
  expect(byId.get('m-none')?.upstreamData).toBeUndefined();

  // search_config.backend & search_usage.backend + CHECK constraint
  const searchConfig = db.prepare('SELECT backend, tavily_api_key FROM search_config WHERE id = 1').get() as { backend: string; tavily_api_key: string };
  expect(searchConfig).toEqual({ backend: 'tavily', tavily_api_key: 'tvly-key' });

  const searchUsage = db.prepare('SELECT backend, key_id, action, hour, requests FROM search_usage').all();
  expect(searchUsage).toEqual([{ backend: 'tavily', key_id: 'key_1', action: 'search', hour: '2026-01-01T00', requests: 7 }]);
  expect(() => db.prepare("INSERT INTO search_usage (backend, key_id, action, hour, requests) VALUES ('bogus', 'key_1', 'search', '2026-01-01T01', 1)").run()).toThrow();

  db.close();
});
