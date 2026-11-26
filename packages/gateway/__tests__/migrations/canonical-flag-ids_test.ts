import { DatabaseSync } from 'node:sqlite';

import { expect, test } from 'vitest';

import { decodeUpstreamFlagOverrides, decodeUpstreamManualModel } from '../../src/repo/upstream-codecs.ts';
import { migrationSqlByFilename } from '../repo/test-sqlite.ts';
import { parseFlagOverridesWire, resolveEffectiveFlags, type UpstreamModelConfig } from '@floway-dev/provider';

const MIGRATION = '0083_canonical_protocol_names.sql';

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

const migrated = (): { overrides: Record<string, boolean>; manualModels: UpstreamModelConfig[] } => {
  const db = new DatabaseSync(':memory:');
  for (const [filename, sql] of migrationSqlByFilename) {
    if (filename === MIGRATION) {
      db.prepare(`
        INSERT INTO upstreams (id, provider, name, created_at, updated_at, config_json, flag_overrides, hue)
        VALUES ('up_legacy', 'custom', 'Legacy', '', '', ?, ?, 210)
      `).run(JSON.stringify(LEGACY_CONFIG), JSON.stringify(LEGACY_OVERRIDES));
    }
    db.exec(sql);
  }
  const row = db.prepare('SELECT flag_overrides AS overrides FROM upstreams').get() as { overrides: string };
  const manualRows = db.prepare("SELECT config_json FROM upstream_manual_models WHERE upstream_id = 'up_legacy' ORDER BY position").all() as { config_json: string }[];
  db.close();
  return {
    overrides: decodeUpstreamFlagOverrides(row.overrides, 'up_legacy'),
    manualModels: manualRows.map(entry => decodeUpstreamManualModel(entry.config_json, 'up_legacy')),
  };
};

const modelOverrides = (manualModels: readonly UpstreamModelConfig[], wireId: string): Record<string, boolean> | undefined =>
  manualModels.find(model => model.upstreamModelId === wireId)?.flagOverrides;

test('the canonical flag-id migration renames the four protocol ids and keeps every toggle a boolean', () => {
  const { overrides, manualModels } = migrated();

  expect(overrides).toEqual({
    'openai-responses-compact-shim': true,
    'anthropic-messages-web-search-shim': false,
    'vendor-qwen': true,
  });
  expect(modelOverrides(manualModels, 'wire-a')).toEqual({
    'openai-responses-web-search-shim': true,
    'openai-responses-image-generation-shim': false,
    'usage-exclusive-cached-tokens': true,
  });
  expect(modelOverrides(manualModels, 'wire-b')).toBeUndefined();

  // The toggles still resolve to the same behavior, read the way the provider
  // reads them: on stays on, off stays off, under the new names.
  expect([...resolveEffectiveFlags([overrides, modelOverrides(manualModels, 'wire-a')])].sort()).toEqual([
    'openai-responses-compact-shim',
    'openai-responses-web-search-shim',
    'usage-exclusive-cached-tokens',
    'vendor-qwen',
  ]);

  // And the row is one the control plane will accept back, which a stale id is
  // not: saving the upstream from the dashboard round-trips this object.
  expect(() => parseFlagOverridesWire(overrides)).not.toThrow();
});
