import { test } from 'vitest';

import { createSqliteTestDb } from './test-sqlite.ts';
import { SqlRepo } from '../../src/repo/sql.ts';
import type { SqlDatabase, SqlPreparedStatement } from '@floway-dev/platform';
import type { UpstreamRecord } from '@floway-dev/provider';
import { assertEquals, assertRejects, stubProviderModel } from '@floway-dev/test-utils';

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
  color: null,
  ...overrides,
});

test('SQL models cache round-trips the catalog revision', async () => {
  const repo = new SqlRepo(await createSqliteTestDb());
  await repo.upstreams.save(baseRecord());
  await repo.modelsCache.put('up_test', {
    revision: 7,
    fetchedAt: 1_700_000_000_000,
    models: [stubProviderModel({ id: 'cached-model' })],
  });

  const cached = await repo.modelsCache.get('up_test');
  assertEquals(cached?.revision, 7);
  assertEquals(cached?.models.map(model => model.id), ['cached-model']);
});

test('SQL upstream repo round-trips state_json on save/list/getById', async () => {
  const repo = new SqlRepo(await createSqliteTestDb()).upstreams;
  const original = baseRecord();
  await repo.save(original);
  assertEquals((await repo.getById('up_test'))?.state, { accounts: [goodAccount] });
  assertEquals((await repo.list())[0].state, { accounts: [goodAccount] });
});

test('SQL upstream repo saveState applies the mutator to the stored state', async () => {
  const repo = new SqlRepo(await createSqliteTestDb()).upstreams;
  await repo.save(baseRecord());
  await repo.saveState('up_test', current => {
    assertEquals(current, { accounts: [goodAccount] });
    return { accounts: [{ ...goodAccount, refresh_token: 'rt_v2' }] };
  });
  assertEquals((await repo.getById('up_test'))?.state, { accounts: [{ ...goodAccount, refresh_token: 'rt_v2' }] });
});

// Deterministic stand-in for a concurrent writer: the first read of
// `state_json` lands an out-of-band write before returning, so the CAS that
// follows it is guaranteed to lose. Without this the retry path is unreachable
// from a single-threaded test.
const withWriterRacingTheFirstRead = (db: SqlDatabase, race: () => Promise<unknown>): SqlDatabase => {
  let raced = false;
  const wrapStatement = (statement: SqlPreparedStatement, racing: boolean): SqlPreparedStatement => ({
    bind: (...values) => wrapStatement(statement.bind(...values), racing),
    all: <T>() => statement.all<T>(),
    run: () => statement.run(),
    first: async <T>() => {
      const row = await statement.first<T>();
      if (racing && !raced) {
        raced = true;
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
  await repo.save(baseRecord());
  const racing = new SqlRepo(withWriterRacingTheFirstRead(db, () =>
    db.prepare('UPDATE upstreams SET state_json = ? WHERE id = ?')
      .bind(JSON.stringify({ accounts: [{ ...goodAccount, state_message: 'written by a sibling' }] }), 'up_test')
      .run())).upstreams;

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

test('SQL upstream repo saveState throws when the row is gone', async () => {
  const repo = new SqlRepo(await createSqliteTestDb()).upstreams;
  await assertRejects(() => repo.saveState('up_missing', current => current), Error, 'disappeared');
});

// A mutator that decided there is nothing to do hands back what it was given.
test('SQL upstream repo saveState skips the write when the mutator changes nothing', async () => {
  const repo = new SqlRepo(await createSqliteTestDb()).upstreams;
  await repo.save(baseRecord());
  await repo.saveState('up_test', current => current);
  assertEquals((await repo.getById('up_test'))?.state, { accounts: [goodAccount] });
});

// sql.js gives us real SQLite semantics in-process (including `IS NULL`
// comparison required for the CAS predicate). The createSqliteTestDb helper
// applies every migration so SqlRepo runs end-to-end against the same SQL
// the production platforms execute.
