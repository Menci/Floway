import { DatabaseSync } from 'node:sqlite';

import { test } from 'vitest';

import { upstreamRecordToJson } from '../../src/control-plane/upstreams/serialize.ts';
import { migrationSqlByFilename } from '../repo/test-sqlite.ts';
import type { ModelEndpoints } from '@floway-dev/protocols/common';
import type { UpstreamRecord } from '@floway-dev/provider';
import { customProviderModule } from '@floway-dev/provider-custom';
import { assertOllamaUpstreamRecord } from '@floway-dev/provider-ollama';
import { assertEquals } from '@floway-dev/test-utils';

const MIGRATION = '0080_drop_targetless_mixed_rerank_endpoints.sql';

const mixedModel = (endpoints: ModelEndpoints, rerankTarget?: { protocol: 'cohere-v2' }, id = 'mixed') => ({
  upstreamModelId: id,
  kind: 'embedding',
  endpoints,
  ...(rerankTarget === undefined ? {} : { rerankTarget }),
});

const baseRecord = (id: string, kind: UpstreamRecord['kind'], config: unknown): UpstreamRecord => ({
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

test('the targetless mixed-rerank migration repairs persisted models and invalidates only affected catalogs', async () => {
  const db = new DatabaseSync(':memory:');
  let migrationSql = '';
  for (const [filename, sql] of migrationSqlByFilename) {
    if (filename === MIGRATION) {
      migrationSql = sql;
      const insert = db.prepare(`
        INSERT INTO upstreams (id, provider, name, created_at, updated_at, config_json, models_cache_json, hue)
        VALUES (?, ?, ?, '2026-08-06', '2026-08-06', ?, ?, 210)
      `);
      insert.run('custom_embedding', 'custom', 'custom_embedding', JSON.stringify({
        baseUrl: 'https://custom.example.com',
        authStyle: 'none',
        endpoints: {},
        ingressHeadersRules: [],
        modelsFetch: { enabled: false },
        models: [mixedModel({ embeddings: {}, rerank: {} })],
      }), JSON.stringify({ revision: 1 }));
      insert.run('custom_image', 'custom', 'custom_image', JSON.stringify({
        baseUrl: 'https://images.example.com',
        authStyle: 'none',
        endpoints: {},
        ingressHeadersRules: [],
        modelsFetch: { enabled: false },
        models: [
          mixedModel({ imagesGenerations: {}, rerank: {} }, undefined, 'image-generations'),
          mixedModel({ imagesEdits: {}, rerank: {} }, undefined, 'image-edits'),
        ],
      }), JSON.stringify({ revision: 1 }));
      insert.run('azure_embedding', 'azure', 'azure_embedding', JSON.stringify({
        endpoint: 'https://example.openai.azure.com',
        apiKey: 'azure-key',
        models: [mixedModel({ embeddings: {}, rerank: {} })],
      }), JSON.stringify({ revision: 1 }));
      insert.run('ollama_embedding', 'ollama', 'ollama_embedding', JSON.stringify({
        baseUrl: 'https://ollama.example.com',
        models: [mixedModel({ embeddings: {}, rerank: {} })],
      }), JSON.stringify({ revision: 1 }));
      insert.run('ollama_images', 'ollama', 'ollama_images', JSON.stringify({
        baseUrl: 'https://ollama-images.example.com',
        models: [
          { upstreamModelId: 'pure-generation', kind: 'image', endpoints: { imagesGenerations: {} } },
          { upstreamModelId: 'pure-edit', kind: 'image', endpoints: { imagesEdits: {} } },
          { upstreamModelId: 'chat-image', kind: 'image', endpoints: { chatCompletions: {}, imagesGenerations: {} } },
          { upstreamModelId: 'embedding-image-rerank', kind: 'embedding', endpoints: { embeddings: {}, imagesEdits: {}, rerank: {} } },
          { upstreamModelId: 'audio-image', kind: 'image', endpoints: { audioTranscriptions: {}, imagesGenerations: {} } },
        ],
      }), JSON.stringify({ revision: 1 }));
      insert.run('custom_targeted', 'custom', 'custom_targeted', JSON.stringify({
        baseUrl: 'https://targeted.example.com',
        authStyle: 'none',
        endpoints: {},
        ingressHeadersRules: [],
        modelsFetch: { enabled: false },
        models: [mixedModel({ embeddings: {}, rerank: {} }, { protocol: 'cohere-v2' })],
      }), JSON.stringify({ revision: 1 }));
      insert.run('custom_chat', 'custom', 'custom_chat', JSON.stringify({
        baseUrl: 'https://chat.example.com',
        authStyle: 'none',
        endpoints: {},
        ingressHeadersRules: [],
        modelsFetch: { enabled: false },
        models: [{ upstreamModelId: 'chat', kind: 'chat', endpoints: { chatCompletions: {} } }],
      }), JSON.stringify({ revision: 1 }));
      insert.run('custom_cache_only', 'custom', 'custom_cache_only', JSON.stringify({
        baseUrl: 'https://cache-only.example.com',
        authStyle: 'none',
        endpoints: { embeddings: {}, rerank: {} },
        ingressHeadersRules: [],
        modelsFetch: { enabled: false },
        models: [],
      }), JSON.stringify({
        revision: 1,
        fetchedAt: 1,
        models: [{ id: 'auto-mixed', kind: 'embedding', limits: {}, endpoints: { embeddings: {}, rerank: {} }, providerData: 'auto-mixed', enabledFlags: [] }],
        lastError: null,
      }));
      insert.run('codex_unrelated', 'codex', 'codex_unrelated', JSON.stringify({
        accounts: [],
        models: [mixedModel({ embeddings: {}, rerank: {} })],
      }), JSON.stringify({ revision: 1 }));
    }
    db.exec(sql);
  }
  if (migrationSql === '') throw new Error(`Missing migration ${MIGRATION}`);

  // A second execution must be a no-op: deploy tooling records migrations, but
  // idempotence keeps local recovery and direct operator execution predictable.
  db.exec(migrationSql);

  const rows = db.prepare('SELECT id, provider, config_json, models_cache_json FROM upstreams ORDER BY id').all() as {
    id: string;
    provider: UpstreamRecord['kind'];
    config_json: string;
    models_cache_json: string | null;
  }[];
  db.close();

  const byId = new Map(rows.map(row => [row.id, row]));
  for (const id of ['custom_embedding', 'custom_image', 'azure_embedding', 'ollama_embedding', 'ollama_images', 'custom_cache_only']) {
    assertEquals(byId.get(id)?.models_cache_json, null);
  }
  for (const id of ['custom_targeted', 'custom_chat', 'codex_unrelated']) {
    assertEquals(byId.get(id)?.models_cache_json, JSON.stringify({ revision: 1 }));
  }

  const endpoints = (id: string) => ((JSON.parse(byId.get(id)!.config_json) as { models: { endpoints: unknown }[] }).models.map(model => model.endpoints));
  assertEquals(endpoints('custom_embedding'), [{ embeddings: {} }]);
  assertEquals(endpoints('custom_image'), [{ imagesGenerations: {} }, { imagesEdits: {} }]);
  assertEquals(endpoints('azure_embedding'), [{ embeddings: {} }]);
  assertEquals(endpoints('ollama_embedding'), [{ embeddings: {} }]);
  assertEquals(endpoints('ollama_images'), [
    { chatCompletions: {} },
    { embeddings: {} },
    { audioTranscriptions: {} },
  ]);
  assertEquals(endpoints('custom_targeted'), [{ embeddings: {}, rerank: {} }]);
  assertEquals(endpoints('codex_unrelated'), [{ embeddings: {}, rerank: {} }]);

  for (const id of ['custom_embedding', 'custom_image', 'azure_embedding', 'ollama_embedding', 'ollama_images', 'custom_targeted', 'custom_cache_only'] as const) {
    const row = byId.get(id)!;
    const record = baseRecord(row.id, row.provider, JSON.parse(row.config_json));
    // Serialization is the control-plane boundary that invokes the owning
    // provider parser; reaching it proves the migrated row is current-schema data.
    upstreamRecordToJson(record);
    if (id === 'custom_embedding') {
      const models = await customProviderModule.create(record).instance.getProvidedModels(() => Promise.reject(new Error('catalog fetch must stay disabled')));
      assertEquals(models.map(model => model.endpoints), [{ embeddings: {} }]);
    }
    if (id === 'custom_cache_only') {
      const models = await customProviderModule.create(record).instance.getProvidedModels(() => Promise.reject(new Error('catalog fetch must stay disabled')));
      assertEquals(models, []);
    }
    if (id === 'ollama_images') {
      const models = assertOllamaUpstreamRecord(record).config.models;
      assertEquals(models.map(model => ({ kind: model.kind, endpoints: model.endpoints })), [
        { kind: 'chat', endpoints: { chatCompletions: {} } },
        { kind: 'embedding', endpoints: { embeddings: {} } },
        { kind: 'transcription', endpoints: { audioTranscriptions: {} } },
      ]);
    }
  }
});
