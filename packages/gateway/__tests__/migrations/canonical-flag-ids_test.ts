import { DatabaseSync } from 'node:sqlite';

import { expect, test } from 'vitest';

import { decodeUpstreamConfig, decodeUpstreamFlagOverrides } from '../../src/repo/upstream-codecs.ts';
import { migrationSqlByFilename } from '../repo/test-sqlite.ts';
import { parseFlagOverridesWire, resolveEffectiveFlags } from '@floway-dev/provider';

const MIGRATION = '0084_canonical_flag_ids.sql';

// The shape an operator's row carried before the rename. Four ids abbreviated a
// protocol and are rewritten; the rest name a vendor dialect or a rewrite and
// must survive untouched, which is what the `vendor-qwen` and
// `usage-exclusive-cached-tokens` entries are here to witness.
//
// `false` is seeded deliberately alongside `true`. An override is a boolean, and
// an off toggle is a real statement — "this default-on flag is off for this
// upstream" — so a migration that turned it into `0`, or lost it, would change
// behavior rather than a name.
const LEGACY_OVERRIDES = {
  'responses-compact-shim': true,
  'messages-web-search-shim': false,
  'vendor-qwen': true,
};

const LEGACY_CONFIG = {
  baseUrl: 'https://upstream.example/v1',
  authStyle: 'bearer',
  apiKey: 'sk-legacy',
  ingressHeadersRules: [],
  endpoints: { openaiResponses: {} },
  models: [
    {
      upstreamModelId: 'wire-a',
      kind: 'chat',
      endpoints: { openaiResponses: {} },
      flagOverrides: {
        'responses-web-search-shim': true,
        'responses-image-generation-shim': false,
        'usage-exclusive-cached-tokens': true,
      },
    },
    // A model with no overrides at all: the rewrite walks every element of the
    // array, so one that has nothing to rewrite must come back unchanged rather
    // than gaining an empty object.
    { upstreamModelId: 'wire-b', kind: 'chat', endpoints: { openaiResponses: {} } },
  ],
};

const seeded = (options: { runMigration: boolean }): { overrides: Record<string, boolean>; config: Record<string, unknown> } => {
  const db = new DatabaseSync(':memory:');
  for (const [filename, sql] of migrationSqlByFilename) {
    if (filename === MIGRATION) {
      db.prepare(`
        INSERT INTO upstreams (id, provider, name, created_at, updated_at, config_json, flag_overrides, hue)
        VALUES ('up_legacy', 'custom', 'Legacy', '', '', ?, ?, 210)
      `).run(JSON.stringify(LEGACY_CONFIG), JSON.stringify(LEGACY_OVERRIDES));
      if (!options.runMigration) continue;
    }
    db.exec(sql);
  }
  const row = db.prepare('SELECT config_json AS config, flag_overrides AS overrides FROM upstreams').get() as { config: string; overrides: string };
  db.close();
  return {
    overrides: decodeUpstreamFlagOverrides(row.overrides, 'up_legacy'),
    config: decodeUpstreamConfig(row.config, 'up_legacy') as Record<string, unknown>,
  };
};

const modelOverrides = (config: Record<string, unknown>, wireId: string): Record<string, boolean> | undefined => {
  const models = config.models as { upstreamModelId: string; flagOverrides?: Record<string, boolean> }[];
  return models.find(model => model.upstreamModelId === wireId)?.flagOverrides;
};

test('the canonical flag-id migration renames the four protocol ids and keeps every toggle a boolean', () => {
  const { overrides, config } = seeded({ runMigration: true });

  expect(overrides).toEqual({
    'openai-responses-compact-shim': true,
    'anthropic-messages-web-search-shim': false,
    'vendor-qwen': true,
  });
  expect(modelOverrides(config, 'wire-a')).toEqual({
    'openai-responses-web-search-shim': true,
    'openai-responses-image-generation-shim': false,
    'usage-exclusive-cached-tokens': true,
  });
  expect(modelOverrides(config, 'wire-b')).toBeUndefined();

  // The toggles still resolve to the same behavior, read the way the provider
  // reads them: on stays on, off stays off, under the new names.
  expect([...resolveEffectiveFlags([overrides, modelOverrides(config, 'wire-a')])].sort()).toEqual([
    'openai-responses-compact-shim',
    'openai-responses-web-search-shim',
    'usage-exclusive-cached-tokens',
    'vendor-qwen',
  ]);

  // And the row is one the control plane will accept back, which a stale id is
  // not: saving the upstream from the dashboard round-trips this object.
  expect(() => parseFlagOverridesWire(overrides)).not.toThrow();
});

test('without the migration the same row carries toggles that no longer apply and cannot be saved', () => {
  // The negative control, in both directions. The read path takes any string
  // key, so the stale overrides decode and then match nothing — `compact-shim`
  // is set and the compaction shim never engages. The write path rejects them,
  // so the operator cannot even re-save the upstream to fix it by hand.
  const { overrides } = seeded({ runMigration: false });

  expect([...resolveEffectiveFlags([overrides])].sort()).toEqual(['responses-compact-shim', 'vendor-qwen']);
  expect(() => parseFlagOverridesWire(overrides)).toThrow(/responses-compact-shim/);
});
