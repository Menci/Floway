import { test } from 'vitest';

import { SqlRepo } from './sql.ts';
import { createSqliteTestDb } from './test-sqlite.ts';
import type { UpstreamRecord } from '@floway-dev/provider';
import { assertEquals } from '@floway-dev/test-utils';

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
  ...overrides,
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
