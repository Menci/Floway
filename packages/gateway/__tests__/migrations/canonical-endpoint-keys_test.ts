import { DatabaseSync } from 'node:sqlite';

import { expect, test } from 'vitest';

import { chatTargetPicker } from '../../src/data-plane/chat/shared/target-picker.ts';
import { decodeUpstreamConfig } from '../../src/repo/upstream-codecs.ts';
import { migrationSqlByFilename } from '../repo/test-sqlite.ts';
import type { UpstreamRecord } from '@floway-dev/provider';
import { assertCustomUpstreamRecord } from '@floway-dev/provider-custom';

const MIGRATION = '0083_canonical_protocol_names.sql';

// The shape an operator's row carried before the rename: the endpoint map keyed
// by the abbreviated protocol names, per model and once at the upstream level.
// One row per family so the negative control can name a key from each — the
// validator throws on the first key it does not know, so a single row would
// only ever witness one of them. `rerank` is seeded unrenamed: it is a model
// kind rather than one vendor's protocol, so the migration must leave it alone.
const LEGACY_CONFIGS = {
  up_legacy_chat: {
    baseUrl: 'https://upstream.example/v1',
    authStyle: 'bearer',
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
    authStyle: 'bearer',
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

const seededConfigs = (options: { runMigration: boolean }): Record<string, unknown> => {
  const db = new DatabaseSync(':memory:');
  for (const [filename, sql] of migrationSqlByFilename) {
    if (filename === MIGRATION) {
      for (const [id, config] of Object.entries(LEGACY_CONFIGS)) {
        db.prepare(`
          INSERT INTO upstreams (id, provider, name, created_at, updated_at, config_json, hue)
          VALUES (?, 'custom', 'Legacy', '', '', ?, 210)
        `).run(id, JSON.stringify(config));
      }
      if (!options.runMigration) continue;
    }
    db.exec(sql);
  }
  const rows = db.prepare('SELECT id, config_json AS config FROM upstreams').all() as { id: string; config: string }[];
  db.close();
  return Object.fromEntries(rows.map(row => [row.id, decodeUpstreamConfig(row.config, row.id)]));
};

// The capability, read the way the provider reads it, rather than the JSON
// shape: that is where a stale key stops being an endpoint at all.
const servedEndpoints = (id: string, config: unknown): { upstream: string[]; models: Record<string, string[]> } => {
  const record = assertCustomUpstreamRecord({ id, kind: 'custom', config } as unknown as UpstreamRecord);
  return {
    upstream: Object.keys(record.config.endpoints),
    models: Object.fromEntries(record.config.models.map(model => [model.upstreamModelId, Object.keys(model.endpoints)])),
  };
};

test('the canonical endpoint-key migration keeps every configured endpoint routable', () => {
  const configs = seededConfigs({ runMigration: true });

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
    'wire-e': ['openaiImagesGenerations', 'openaiImagesEdits'],
    'wire-f': ['openaiAudioTranscriptions'],
    'wire-g': ['rerank'],
  });

  const picker = chatTargetPicker(['openaiResponses', 'anthropicMessages', 'openaiChatCompletions']);
  expect(picker.canServe({ openaiResponses: {} })).toBe(true);
  expect(picker.pick({ openaiResponses: {} })).toBe('openaiResponses');
});

test('without the migration the same rows stop declaring any endpoint the new code understands', () => {
  // The negative control. `endpointsSchema` is a passthrough object of optional
  // keys, so the stale rows still decode at the repository boundary; the
  // rejection lands one layer in, where the provider validates the map, and it
  // takes the whole upstream with it.
  const stale = seededConfigs({ runMigration: false });
  expect(() => servedEndpoints('up_legacy_chat', stale.up_legacy_chat)).toThrow(/unsupported endpoint chatCompletions/);
  expect(() => servedEndpoints('up_legacy_media', stale.up_legacy_media)).toThrow(/unsupported endpoint audioTranscriptions/);
});
