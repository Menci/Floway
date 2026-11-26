import { test } from 'vitest';

import { seedModelsCache } from './models-cache-fixture.ts';
import { createSqliteTestDb } from './test-sqlite.ts';
import { saveUpstreamForTest } from './upstreams.ts';
import { MODEL_CATALOG_REVISION } from '../../src/repo/models-cache-contract.ts';
import { SqlRepo } from '../../src/repo/sql.ts';
import { UPSTREAM_STATE_WRITE_ATTEMPTS } from '../../src/repo/upstream-models-sql.ts';
import type { SqlDatabase, SqlPreparedStatement } from '@floway-dev/platform';
import { assertEquals, assertRejects, stubUpstreamModel } from '@floway-dev/test-utils';
import type { UpstreamRecord } from '@floway-dev/upstream';

const goodAccount = { chatgptAccountId: 'aid', refresh_token: 'rt_v1', state: 'active' as const, state_updated_at: '2026-01-01T00:00:00Z' };
const GENERATION = '2026-06-05T00:00:00.000Z';
const baseRecord = (overrides: Partial<UpstreamRecord> = {}): UpstreamRecord => ({
  id: 'up_test',
  kind: 'chatgpt',
  name: 'ChatGPT Test',
  enabled: true,
  usageRefreshIntervalMinutes: 0,
  sortOrder: 0,
  createdAt: '2026-06-05T00:00:00.000Z',
  updatedAt: GENERATION,
  config: { accounts: [{ email: 'a@b.com', chatgptAccountId: 'aid', chatgptUserId: 'uid', planType: 'plus' }] },
  state: { accounts: [goodAccount] },
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  hue: 210,
  ...overrides,
});

const ownValue = (value: unknown, key: string): unknown => {
  if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) {
    throw new Error(`Expected own property ${JSON.stringify(key)}`);
  }
  return Reflect.get(value, key);
};

test('SQL upstream repo preserves opaque provider data while restoring only the model enabledFlags Set', async () => {
  const fullRepo = new SqlRepo(await createSqliteTestDb());
  await saveUpstreamForTest(fullRepo.upstreams, baseRecord());
  const inserted = (await fullRepo.upstreams.getById('up_test'))!;
  await seedModelsCache(fullRepo.upstreams, 'up_test', {
    version: inserted.version,
    revision: MODEL_CATALOG_REVISION,
    fetchedAt: 1_700_000_000_000,
    models: [stubUpstreamModel({
      id: 'cached-model',
      upstreamData: JSON.parse('{"enabledFlags":["provider-private"],"future":{"__proto__":{"marker":"provider"}}}'),
    })],
  });

  const model = (await fullRepo.upstreamModels.listByUpstream('up_test'))[0]?.model;
  assertEquals(model?.enabledFlags instanceof Set, true);
  assertEquals(ownValue(model?.upstreamData, 'enabledFlags'), ['provider-private']);
  assertEquals(ownValue(ownValue(ownValue(model?.upstreamData, 'future'), '__proto__'), 'marker'), 'provider');
});

// Deterministic stand-in for a concurrent writer: each of the first `times`
// reads of `state_json` lands an out-of-band write before returning, so that
// many CAS attempts are guaranteed to lose. Without this neither the retry nor
// the exhaustion path is reachable from a single-threaded test.
const withWriterRacingReads = (db: SqlDatabase, race: () => Promise<unknown>, times: number): SqlDatabase => {
  let raced = 0;
  const wrapStatement = (statement: SqlPreparedStatement, racing: boolean): SqlPreparedStatement => ({
    bind: (...values) => wrapStatement(statement.bind(...values), racing),
    all: <T>() => statement.all<T>(),
    run: () => statement.run(),
    first: async <T>() => {
      const row = await statement.first<T>();
      if (racing && raced < times) {
        raced += 1;
        await race();
      }
      return row;
    },
  });
  return {
    prepare: query => wrapStatement(db.prepare(query), query.startsWith('SELECT state_json')),
    exec: sql => db.exec(sql),
  };
};

// The reason the change is a function rather than a document: the writer whose
// read was invalidated re-derives its change from the state that won, so both
// survive. A caller that had computed its document up front would instead
// reinstate the value the winner replaced.
test('SQL upstream repo saveState re-applies the mutator against the write that won', async () => {
  const db = await createSqliteTestDb();
  const repo = new SqlRepo(db).upstreams;
  await saveUpstreamForTest(repo, baseRecord());
  const racing = new SqlRepo(withWriterRacingReads(db, () =>
    db.prepare('UPDATE upstreams SET state_json = ? WHERE id = ?')
      .bind(JSON.stringify({ accounts: [{ ...goodAccount, state_message: 'written by a sibling' }] }), 'up_test')
      .run(), 1)).upstreams;

  const seen: string[] = [];
  await racing.saveState('up_test', current => {
    const [account] = (current as { accounts: { state_message?: string }[] }).accounts;
    seen.push(account.state_message ?? '(none)');
    return { accounts: [{ ...account, refresh_token: 'rt_v2' }] };
  });

  // First attempt read the pre-race state, the retry read the sibling's.
  assertEquals(seen, ['(none)', 'written by a sibling']);
  const stored = (await repo.getById('up_test'))?.state as { accounts: { refresh_token: string; state_message?: string }[] };
  assertEquals(stored.accounts[0].refresh_token, 'rt_v2');
  assertEquals(stored.accounts[0].state_message, 'written by a sibling');
});

// A writer that never wins gives up rather than looping, and says so instead
// of reporting a flag a caller could drop.
test('SQL upstream repo saveState gives up after a bounded number of lost races', async () => {
  const db = await createSqliteTestDb();
  const repo = new SqlRepo(db).upstreams;
  await saveUpstreamForTest(repo, baseRecord());
  let siblingWrites = 0;
  const racing = new SqlRepo(withWriterRacingReads(db, () => {
    siblingWrites += 1;
    return db.prepare('UPDATE upstreams SET state_json = ? WHERE id = ?')
      .bind(JSON.stringify({ accounts: [{ ...goodAccount, state_message: `sibling ${siblingWrites}` }] }), 'up_test')
      .run();
  }, Number.MAX_SAFE_INTEGER)).upstreams;

  let attempts = 0;
  await assertRejects(
    () => racing.saveState('up_test', current => {
      attempts += 1;
      const [account] = (current as { accounts: Record<string, unknown>[] }).accounts;
      return { accounts: [{ ...account, refresh_token: 'rt_v2' }] };
    }),
    Error,
    'consecutive races',
  );
  // Every attempt ran the mutator, and none of them landed.
  assertEquals(attempts, UPSTREAM_STATE_WRITE_ATTEMPTS);
  const stored = (await repo.getById('up_test'))?.state as { accounts: { refresh_token: string }[] };
  assertEquals(stored.accounts[0].refresh_token, goodAccount.refresh_token);
});

// sql.js gives us real SQLite semantics in-process (including `IS NULL`
// comparison required for the CAS predicate). The createSqliteTestDb helper
// applies every migration so SqlRepo runs end-to-end against the same SQL
// the production platforms execute.

for (const initialState of [null, { accounts: [goodAccount] }]) test(`SQL state CAS rechecks the config version after a competing config write (state=${initialState === null ? 'null' : 'populated'})`, async () => {
  const db = await createSqliteTestDb();
  const repo = new SqlRepo(db).upstreams;
  await saveUpstreamForTest(repo, baseRecord({ state: initialState }));
  const version = (await repo.getById('up_test'))!.version;
  const racing = new SqlRepo(withWriterRacingReads(db, () =>
    db.prepare('UPDATE upstreams SET version = version + 1 WHERE id = ?').bind('up_test').run(), 1)).upstreams;
  const seen: number[] = [];
  await racing.saveState('up_test', (current, currentVersion) => {
    seen.push(currentVersion);
    return currentVersion === version ? { accounts: [{ ...goodAccount, refresh_token: 'stale-probe' }] } : current;
  });
  assertEquals((await repo.getById('up_test'))?.state, initialState);
  assertEquals(seen, [version, version + 1]);
});
