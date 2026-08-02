import { test } from 'vitest';

import { createSqliteTestDb } from './test-sqlite.ts';
import { SqlRepo } from '../../src/repo/sql.ts';
import type { UpstreamRecord } from '@floway-dev/provider';
import { assertEquals, stubProviderModel } from '@floway-dev/test-utils';

const goodAccount = { chatgptAccountId: 'aid', refresh_token: 'rt_v1', state: 'active' as const, state_updated_at: '2026-01-01T00:00:00Z' };
const baseRecord = (overrides: Partial<UpstreamRecord> = {}): UpstreamRecord => ({
  id: 'up_test',
  kind: 'codex',
  name: 'Codex Test',
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-06-05T00:00:00.000Z',
  updatedAt: '2026-06-05T00:00:00.000Z',
  config: { accounts: [{ email: 'a@b.com', chatgptAccountId: 'aid', chatgptUserId: 'uid', planType: 'plus' }] },
  state: { accounts: [goodAccount] },
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  modelsCache: null,
  color: null,
  ...overrides,
});

test('SQL upstream repo round-trips the cached catalog and its revision', async () => {
  const repo = new SqlRepo(await createSqliteTestDb()).upstreams;
  await repo.save(baseRecord());
  await repo.saveModelsCache('up_test', {
    revision: 7,
    fetchedAt: 1_700_000_000_000,
    models: [stubProviderModel({ id: 'cached-model' })],
  });

  const cached = (await repo.getById('up_test'))?.modelsCache;
  assertEquals(cached?.revision, 7);
  assertEquals(cached?.fetchedAt, 1_700_000_000_000);
  assertEquals(cached?.models.map(model => model.id), ['cached-model']);
  assertEquals(cached?.lastError, null);
});

test('SQL upstream repo saveModelsCacheError annotates a cached catalog and saveModelsCache clears it', async () => {
  const repo = new SqlRepo(await createSqliteTestDb()).upstreams;
  await repo.save(baseRecord());
  await repo.saveModelsCache('up_test', {
    revision: 7,
    fetchedAt: 1_700_000_000_000,
    models: [stubProviderModel({ id: 'cached-model' })],
  });

  await repo.saveModelsCacheError('up_test', { message: 'boom', at: 1_700_000_500_000 });
  const annotated = (await repo.getById('up_test'))?.modelsCache;
  assertEquals(annotated?.lastError, { message: 'boom', at: 1_700_000_500_000 });
  assertEquals(annotated?.models.map(model => model.id), ['cached-model']);

  await repo.saveModelsCache('up_test', {
    revision: 7,
    fetchedAt: 1_700_001_000_000,
    models: [stubProviderModel({ id: 'refreshed-model' })],
  });
  assertEquals((await repo.getById('up_test'))?.modelsCache?.lastError, null);
});

test('SQL upstream repo saveModelsCacheError is a no-op on a row that never cached a catalog', async () => {
  const repo = new SqlRepo(await createSqliteTestDb()).upstreams;
  await repo.save(baseRecord());

  await repo.saveModelsCacheError('up_test', { message: 'boom', at: 1_700_000_500_000 });

  assertEquals((await repo.getById('up_test'))?.modelsCache, null);
});

test('SQL upstream repo save leaves an existing cached catalog alone', async () => {
  const repo = new SqlRepo(await createSqliteTestDb()).upstreams;
  await repo.save(baseRecord());
  await repo.saveModelsCache('up_test', {
    revision: 7,
    fetchedAt: 1_700_000_000_000,
    models: [stubProviderModel({ id: 'cached-model' })],
  });

  // An operator edit carries whatever catalog the request happened to read —
  // here, none at all. The refresh path stays the only writer.
  await repo.save(baseRecord({ name: 'Renamed', modelsCache: null }));

  const record = await repo.getById('up_test');
  assertEquals(record?.name, 'Renamed');
  assertEquals(record?.modelsCache?.models.map(model => model.id), ['cached-model']);
});

test('SQL upstream repo round-trips state_json on save/list/getById', async () => {
  const repo = new SqlRepo(await createSqliteTestDb()).upstreams;
  const original = baseRecord();
  await repo.save(original);
  assertEquals((await repo.getById('up_test'))?.state, { accounts: [goodAccount] });
  assertEquals((await repo.list())[0].state, { accounts: [goodAccount] });
});

test('SQL upstream repo saveState writes when expectedState matches', async () => {
  const repo = new SqlRepo(await createSqliteTestDb()).upstreams;
  await repo.save(baseRecord());
  const nextAccount = { ...goodAccount, refresh_token: 'rt_v2' };
  const result = await repo.saveState(
    'up_test',
    { accounts: [nextAccount] },
    { expectedState: { accounts: [goodAccount] } },
  );
  assertEquals(result.updated, true);
  assertEquals((await repo.getById('up_test'))?.state, { accounts: [nextAccount] });
});

test('SQL upstream repo saveState refuses when expectedState diverges (operator re-import race)', async () => {
  const repo = new SqlRepo(await createSqliteTestDb()).upstreams;
  await repo.save(baseRecord());
  const operatorAccount = { ...goodAccount, refresh_token: 'rt_operator_new' };
  // Simulate operator re-import that replaced the credential out-of-band.
  await repo.save(baseRecord({ state: { accounts: [operatorAccount] } }));
  const result = await repo.saveState(
    'up_test',
    { accounts: [{ ...goodAccount, refresh_token: 'rt_v2' }] },
    { expectedState: { accounts: [goodAccount] } },
  );
  assertEquals(result.updated, false);
  assertEquals((await repo.getById('up_test'))?.state, { accounts: [operatorAccount] });
});

test('SQL upstream repo saveState round-trip uses canonical JSON form (back-to-back CAS works)', async () => {
  const repo = new SqlRepo(await createSqliteTestDb()).upstreams;
  await repo.save(baseRecord());
  const v2Account = { state: 'active' as const, refresh_token: 'rt_v2', chatgptAccountId: 'aid', state_updated_at: '2026-01-02T00:00:00Z' }; // intentionally re-ordered keys
  // First CAS: prior state shape from save() must match.
  const first = await repo.saveState(
    'up_test',
    { accounts: [v2Account] },
    { expectedState: { accounts: [goodAccount] } },
  );
  assertEquals(first.updated, true);
  // Second CAS: the previously-written shape must serialize identically when
  // passed back as expectedState (regardless of input key order).
  const second = await repo.saveState(
    'up_test',
    { accounts: [{ ...v2Account, refresh_token: 'rt_v3' }] },
    { expectedState: { accounts: [v2Account] } },
  );
  assertEquals(second.updated, true);
});

// sql.js gives us real SQLite semantics in-process (including `IS NULL`
// comparison required for the CAS predicate). The createSqliteTestDb helper
// applies every migration so SqlRepo runs end-to-end against the same SQL
// the production platforms execute.
