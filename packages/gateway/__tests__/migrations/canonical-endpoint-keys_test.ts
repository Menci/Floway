import { DatabaseSync } from 'node:sqlite';

import { expect, test } from 'vitest';

import { chatTargetPicker } from '../../src/data-plane/chat/shared/target-picker.ts';
import { decodeUpstreamConfig, decodeUpstreamManualModel } from '../../src/repo/upstream-codecs.ts';
import { migrationSqlByFilename } from '../repo/test-sqlite.ts';
import type { UpstreamModelConfig, UpstreamRecord } from '@floway-dev/provider';
import { assertCustomUpstreamRecord, validateCustomManualModels } from '@floway-dev/provider-custom';

const MIGRATION = '0083_canonical_protocol_names.sql';

// The shape an operator's row carried before the rename: the endpoint map keyed
// by the abbreviated protocol names, per model and once at the upstream level.
// `rerank` is seeded unrenamed: it is a model kind rather than one vendor's
// protocol, so the migration must leave it alone.
const LEGACY_CONFIGS = {
  up_legacy_chat: {
    baseUrl: 'https://upstream.example/v1',
    apiKey: 'sk-legacy',
    ingressHeadersRules: [],
    endpoints: { chatCompletions: {} },
    models: [
      { upstreamModelId: 'wire-a', kind: 'chat', endpoints: { responses: {} } },
      { upstreamModelId: 'wire-b', kind: 'chat', endpoints: { messages: {}, chatCompletions: {} } },
      { upstreamModelId: 'wire-c', kind: 'chat', endpoints: { completions: {} } },
    ],
  },
  up_legacy_media: {
    baseUrl: 'https://media.example/v1',
    apiKey: 'sk-media',
    ingressHeadersRules: [],
    endpoints: { audioTranscriptions: {} },
    models: [
      { upstreamModelId: 'wire-d', kind: 'embedding', endpoints: { embeddings: {} } },
      { upstreamModelId: 'wire-e', kind: 'image', endpoints: { imagesGenerations: {}, imagesEdits: {} } },
      { upstreamModelId: 'wire-f', kind: 'transcription', endpoints: { audioTranscriptions: {} } },
      { upstreamModelId: 'wire-g', kind: 'rerank', endpoints: { rerank: {} }, rerankTarget: { protocol: 'cohere-v2' } },
    ],
  },
};

const migratedConfigs = (): Record<string, { config: unknown; manualModels: UpstreamModelConfig[] }> => {
  const db = new DatabaseSync(':memory:');
  for (const [filename, sql] of migrationSqlByFilename) {
    if (filename === MIGRATION) {
      for (const [id, config] of Object.entries(LEGACY_CONFIGS)) {
        db.prepare(`
          INSERT INTO upstreams (id, provider, name, created_at, updated_at, config_json, hue)
          VALUES (?, 'custom', 'Legacy', '', '', ?, 210)
        `).run(id, JSON.stringify(config));
      }
    }
    db.exec(sql);
  }
  const rows = db.prepare('SELECT id, config_json AS config FROM upstreams').all() as { id: string; config: string }[];
  const manualRows = db.prepare('SELECT upstream_id, config_json FROM upstream_manual_models ORDER BY upstream_id, position').all() as { upstream_id: string; config_json: string }[];
  db.close();
  const manualByUpstream = new Map<string, UpstreamModelConfig[]>();
  for (const row of manualRows) {
    const list = manualByUpstream.get(row.upstream_id) ?? [];
    list.push(decodeUpstreamManualModel(row.config_json, row.upstream_id));
    manualByUpstream.set(row.upstream_id, list);
  }
  return Object.fromEntries(rows.map(row => [row.id, {
    config: decodeUpstreamConfig(row.config, row.id),
    manualModels: manualByUpstream.get(row.id) ?? [],
  }]));
};

// The capability, read the way the provider reads it, rather than the JSON
// shape: that is where a stale key stops being an endpoint at all.
const servedEndpoints = (id: string, entry: { config: unknown; manualModels: UpstreamModelConfig[] }): { upstream: string[]; models: Record<string, string[]> } => {
  const record = assertCustomUpstreamRecord({ id, kind: 'custom', config: entry.config } as unknown as UpstreamRecord);
  const manualModels = validateCustomManualModels(entry.manualModels);
  return {
    upstream: Object.keys(record.config.endpoints).toSorted(),
    models: Object.fromEntries(manualModels.map(model => [model.upstreamModelId, Object.keys(model.endpoints).toSorted()])),
  };
};

test('the canonical endpoint-key migration keeps every configured endpoint routable', () => {
  const configs = migratedConfigs();

  const chat = servedEndpoints('up_legacy_chat', configs.up_legacy_chat);
  expect(chat.upstream).toEqual(['openaiChatCompletions']);
  expect(chat.models).toEqual({
    'wire-a': ['openaiResponses'],
    'wire-b': ['anthropicMessages', 'openaiChatCompletions'],
    'wire-c': ['openaiCompletions'],
  });

  const media = servedEndpoints('up_legacy_media', configs.up_legacy_media);
  expect(media.upstream).toEqual(['openaiAudioTranscriptions']);
  expect(media.models).toEqual({
    'wire-d': ['openaiEmbeddings'],
    'wire-e': ['openaiImagesEdits', 'openaiImagesGenerations'],
    'wire-f': ['openaiAudioTranscriptions'],
    'wire-g': ['rerank'],
  });

  const picker = chatTargetPicker(['openaiResponses', 'anthropicMessages', 'openaiChatCompletions']);
  expect(picker.canServe({ openaiResponses: {} })).toBe(true);
  expect(picker.pick({ openaiResponses: {} })).toBe('openaiResponses');
});
