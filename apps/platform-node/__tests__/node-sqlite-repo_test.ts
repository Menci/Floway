import { test } from 'vitest';

import { applyMigrations } from '../src/migrate.ts';
import { createNodeSqliteDatabase } from '../src/node-sqlite-database.ts';
import { MODEL_CATALOG_REVISION, SqlRepo } from '@floway-dev/gateway';
import { assertEquals, stubProviderModel } from '@floway-dev/test-utils';

// The repo layer's own suite runs against sql.js, which — like D1 — coerces a
// JS boolean to 0/1. `node:sqlite` rejects it outright, so a bind the Workers
// target tolerates surfaces only here. These drive the real repo through the
// real driver over the real migrations.
//
// `:memory:` keeps the driver and its parameter binding exactly as a deployed
// instance sees them while leaving no file to unlink — node:sqlite holds the
// handle open for the process lifetime, which makes tempfile cleanup fail on
// Windows.
const withRepo = async (fn: (repo: SqlRepo) => Promise<void>): Promise<void> => {
  const db = createNodeSqliteDatabase(':memory:');
  await applyMigrations(db);
  await fn(new SqlRepo(db));
};

const seedKey = (repo: SqlRepo): Promise<void> => repo.apiKeys.save({
  id: 'key_node',
  userId: 1,
  name: 'Node key',
  key: 'raw_node_key',
  serverSecret: '00'.repeat(32),
  createdAt: '2026-07-26T00:00:00.000Z',
  upstreamIds: null,
  deletedAt: null,
  dumpRetentionSeconds: null,
  responsesRetentionSeconds: 0,
});

test('api key update lands every patched column and leaves the rest alone', () => withRepo(async repo => {
  await seedKey(repo);

  // recordUsage() takes this path after every proxied request.
  const touched = await repo.apiKeys.update('key_node', { lastUsedAt: '2026-07-26T12:00:00.000Z' });
  assertEquals(touched?.lastUsedAt, '2026-07-26T12:00:00.000Z');
  // The columns whose CASE WHEN guard is false must survive untouched.
  assertEquals(touched?.name, 'Node key');
  assertEquals(touched?.responsesRetentionSeconds, 0);

  // The control-plane edits (PATCH /api/keys/:id, rotate) share the bind.
  const edited = await repo.apiKeys.update('key_node', {
    name: 'Renamed',
    key: 'rotated_key',
    upstreamIds: ['up-a'],
    dumpRetentionSeconds: 3600,
    responsesRetentionSeconds: 7 * 24 * 60 * 60,
  });
  assertEquals(edited?.name, 'Renamed');
  assertEquals(edited?.upstreamIds, ['up-a']);
  assertEquals(edited?.dumpRetentionSeconds, 3600);
  // Not in the patch — the earlier value stays.
  assertEquals(edited?.lastUsedAt, '2026-07-26T12:00:00.000Z');

  assertEquals((await repo.apiKeys.getById('key_node'))?.name, 'Renamed');
}));

test('expiration sweep completion lands on both discriminants', () => withRepo(async repo => {
  await seedKey(repo);

  await repo.expirationSweeps.schedule('responses', 'key_node', 0);
  const partialClaim = await repo.expirationSweeps.claim('claim-partial', 10, 0);
  if (partialClaim === null) throw new Error('expected an expiration claim');
  await repo.expirationSweeps.complete('claim-partial', partialClaim.revision, { kind: 'partial', retryAt: 5_000 });

  const drainedClaim = await repo.expirationSweeps.claim('claim-drained', 10_000, 0);
  if (drainedClaim === null) throw new Error('expected a re-claim after the partial retry');
  await repo.expirationSweeps.complete('claim-drained', drainedClaim.revision, { kind: 'drained', nextDueAt: null });

  assertEquals(await repo.expirationSweeps.claim('claim-empty', 20_000, 0), null);
}));

test('repository JSON codecs round-trip upstream, alias, and Responses state through node:sqlite', () => withRepo(async repo => {
  await seedKey(repo);
  await repo.upstreams.save({
    id: 'up_node',
    kind: 'custom',
    name: 'Node upstream',
    enabled: true,
    sortOrder: 0,
    createdAt: '2026-08-05T00:00:00.000Z',
    updatedAt: '2026-08-05T00:00:00.000Z',
    config: { opaque: { value: true } },
    state: { cursor: ['a', 1] },
    modelsCache: null,
    flagOverrides: {},
    disabledPublicModelIds: [],
    proxyFallbackList: [],
    modelPrefix: null,
    hue: 210,
  });
  await repo.upstreams.saveModelsCache('up_node', {
    revision: MODEL_CATALOG_REVISION,
    fetchedAt: 1_786_000_000_000,
    models: [stubProviderModel({ id: 'node-model', enabledFlags: new Set(['vendor-kimi'] as const) })],
  });
  await repo.modelAliases.insert({
    id: 'alias_node',
    name: 'node-alias',
    kind: 'chat',
    selection: 'first-available',
    displayName: null,
    visibleInModelsList: true,
    targets: [{ target_model_id: 'node-model', rules: { reasoning: { effort: 'high' } } }],
    announcedMetadata: { limits: { max_output_tokens: 4096 } },
    sortOrder: 0,
    createdAt: '2026-08-05T00:00:00.000Z',
    updatedAt: '2026-08-05T00:00:00.000Z',
  });
  await repo.responsesSnapshots.insert({
    id: 'resp_node',
    apiKeyId: 'key_node',
    itemIds: ['msg-a', 'msg-b'],
    refreshedAt: 1_786_000_000_000,
  });

  const upstream = await repo.upstreams.getById('up_node');
  assertEquals(upstream?.config, { opaque: { value: true } });
  assertEquals(upstream?.state, { cursor: ['a', 1] });
  assertEquals(upstream?.modelsCache?.models[0].id, 'node-model');
  assertEquals(upstream?.modelsCache?.models[0].enabledFlags instanceof Set, true);
  assertEquals((await repo.modelAliases.getById('alias_node'))?.announcedMetadata, { limits: { max_output_tokens: 4096 } });
  assertEquals((await repo.responsesSnapshots.lookup('key_node', 'resp_node', 0))?.itemIds, ['msg-a', 'msg-b']);
}));
