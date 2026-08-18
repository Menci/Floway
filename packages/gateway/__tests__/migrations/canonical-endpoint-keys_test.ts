import { DatabaseSync } from 'node:sqlite';

import { expect, test } from 'vitest';

import { chatTargetPicker } from '../../src/data-plane/chat/shared/target-picker.ts';
import { decodeUpstreamConfig } from '../../src/repo/upstream-codecs.ts';
import { migrationSqlByFilename } from '../repo/test-sqlite.ts';
import type { UpstreamRecord } from '@floway-dev/provider';
import { assertCustomUpstreamRecord } from '@floway-dev/provider-custom';

const MIGRATION = '0083_canonical_endpoint_keys.sql';

// The shape an operator's row carried before the rename: the endpoint map keyed
// by the abbreviated protocol names, per model and once at the upstream level.
const LEGACY_CONFIG = {
  baseUrl: 'https://upstream.example/v1',
  authStyle: 'bearer',
  apiKey: 'sk-legacy',
  ingressHeadersRules: [],
  endpoints: { chatCompletions: {} },
  models: [
    { upstreamModelId: 'wire-a', kind: 'chat', endpoints: { responses: {} } },
    { upstreamModelId: 'wire-b', kind: 'chat', endpoints: { messages: {}, chatCompletions: {} } },
    { upstreamModelId: 'wire-c', kind: 'embedding', endpoints: { embeddings: {} } },
  ],
};

const seededConfig = (options: { runMigration: boolean }): unknown => {
  const db = new DatabaseSync(':memory:');
  for (const [filename, sql] of migrationSqlByFilename) {
    if (filename === MIGRATION) {
      db.prepare(`
        INSERT INTO upstreams (id, provider, name, created_at, updated_at, config_json, hue)
        VALUES ('up_legacy', 'custom', 'Legacy', '', '', ?, 210)
      `).run(JSON.stringify(LEGACY_CONFIG));
      if (!options.runMigration) continue;
    }
    db.exec(sql);
  }
  const row = db.prepare("SELECT config_json AS config FROM upstreams WHERE id = 'up_legacy'").get() as { config: string };
  db.close();
  return decodeUpstreamConfig(row.config, 'up_legacy');
};

// The capability, read the way the provider reads it, rather than the JSON
// shape: that is where a stale key stops being an endpoint at all.
const servedEndpoints = (config: unknown): { upstream: string[]; models: Record<string, string[]> } => {
  const record = assertCustomUpstreamRecord({ id: 'up_legacy', kind: 'custom', config } as unknown as UpstreamRecord);
  return {
    upstream: Object.keys(record.config.endpoints),
    models: Object.fromEntries(record.config.models.map(model => [model.upstreamModelId, Object.keys(model.endpoints)])),
  };
};

test('the canonical endpoint-key migration keeps every configured endpoint routable', () => {
  const served = servedEndpoints(seededConfig({ runMigration: true }));

  expect(served.upstream).toEqual(['openaiChatCompletions']);
  expect(served.models).toEqual({
    'wire-a': ['openaiResponses'],
    'wire-b': ['anthropicMessages', 'openaiChatCompletions'],
    'wire-c': ['embeddings'],
  });

  const picker = chatTargetPicker(['openaiResponses', 'anthropicMessages', 'openaiChatCompletions']);
  expect(picker.canServe({ openaiResponses: {} })).toBe(true);
  expect(picker.pick({ openaiResponses: {} })).toBe('openaiResponses');
});

test('without the migration the same row stops declaring any endpoint the new code understands', () => {
  // The negative control. `endpointsSchema` is a passthrough object of optional
  // keys, so the stale row still decodes at the repository boundary; the
  // rejection lands one layer in, where the provider validates the map, and it
  // takes the whole upstream with it.
  const stale = seededConfig({ runMigration: false });
  expect(() => servedEndpoints(stale)).toThrow(/unsupported endpoint chatCompletions/);
});
